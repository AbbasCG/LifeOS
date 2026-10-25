<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\Recommendation;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

/**
 * Proactive Copilot: notices situations worth acting on and suggests one concrete next step.
 *
 * - Relevant: every recommendation comes from the intelligence snapshot with its evidence, confidence and sources.
 * - Deduplicated: each situation has a stable key; it is shown once, updated in place, and never re-shown after being
 *   dismissed (snoozed ones return after the snooze). Situations that no longer apply are resolved automatically.
 * - Non-intrusive: in-app by default, at most MAX_ACTIVE at a time, notifications only with the "daily" frequency and at
 *   most one per day. Personalization (opt-in) quiets types the user keeps marking "not useful".
 * - Never autonomous: acting creates a proposal through the existing approval flow (with undo); links only navigate.
 */
class RecommendationService
{
    public const TYPES = ['deadline', 'conflict', 'overload', 'goal', 'postponed', 'focus'];

    public const MAX_ACTIVE = 6;

    public const SNOOZE_DAYS = [1, 3, 7];

    /** With personalization on, a type marked "not useful" this many times (and more often than useful) is quieted. */
    public const QUIET_AFTER = 3;

    public function __construct(private IntelligenceService $intelligence, private AssistantActions $actions, private Notifier $notifier, private AuditLogger $audit) {}

    /**
     * Refresh and return the active recommendations, most important first.
     *
     * @return Collection<int, Recommendation>
     */
    public function current(User $user): Collection
    {
        if (! $this->enabled($user)) {
            return collect();
        }
        $this->refresh($user);

        return Recommendation::where('user_id', $user->id)->where('status', 'active')->get()
            ->sortBy(fn (Recommendation $r) => [$r->severity === 'high' ? 0 : ($r->severity === 'medium' ? 1 : 2), $r->first_seen_at->getTimestamp()])
            ->take(self::MAX_ACTIVE)->values();
    }

    public function enabled(User $user): bool
    {
        return IntelligenceSettings::feature($user, 'recommendations') && IntelligenceSettings::for($user)['frequency'] !== 'off';
    }

    /**
     * Recompute the candidate situations and reconcile them with what is stored.
     */
    public function refresh(User $user): void
    {
        $now = now();
        $candidates = $this->candidates($user)->keyBy('key');
        $quiet = $this->quietTypes($user);
        $existing = Recommendation::where('user_id', $user->id)->whereIn('key', $candidates->keys())->get()->keyBy('key');
        foreach ($candidates as $key => $c) {
            if (in_array($c['type'], $quiet, true) && $c['severity'] !== 'high') {
                continue;
            }
            $row = $existing->get($key);
            $payload = ['title' => $c['title'], 'detail' => $c['detail'], 'confidence' => $c['confidence'], 'sources' => $c['sources'], 'evidence' => $c['evidence'], 'action' => $c['action'], 'subject' => $c['subject']];
            if (! $row) {
                Recommendation::create(['user_id' => $user->id, 'key' => $key, 'type' => $c['type'], 'severity' => $c['severity'], 'status' => 'active', 'payload' => $payload, 'first_seen_at' => $now, 'last_seen_at' => $now]);

                continue;
            }
            $wake = $row->status === 'snoozed' && $row->snoozed_until && $row->snoozed_until->isPast();
            $row->forceFill(['severity' => $c['severity'], 'payload' => $payload, 'last_seen_at' => $now] + ($wake || $row->status === 'resolved' ? ['status' => 'active', 'snoozed_until' => null] : []))->save();
        }
        // Situations that no longer apply are resolved, not deleted, so the history stays honest.
        Recommendation::where('user_id', $user->id)->where('status', 'active')->whereNotIn('key', $candidates->keys()->all() ?: ['__none__'])->update(['status' => 'resolved', 'updated_at' => $now]);
        $this->notify($user);
    }

    public function dismiss(User $user, Recommendation $rec, ?int $snoozeDays, ?Request $request = null): Recommendation
    {
        $rec->forceFill($snoozeDays
            ? ['status' => 'snoozed', 'snoozed_until' => now()->addDays($snoozeDays)]
            : ['status' => 'dismissed', 'dismissed_at' => now()])->save();
        $this->audit->log($user, 'recommendation_dismissed', $request, ['type' => $rec->type, 'snooze_days' => $snoozeDays]);

        return $rec;
    }

    public function feedback(User $user, Recommendation $rec, bool $useful): Recommendation
    {
        $rec->forceFill(['feedback' => $useful ? 'useful' : 'not_useful', 'feedback_at' => now()])->save();

        return $rec;
    }

    /**
     * Turn a recommendation into a proposal the user reviews and approves (nothing changes here).
     */
    public function act(User $user, Recommendation $rec, ?Request $request = null): AssistantProposal
    {
        $action = $rec->payload['action'] ?? null;
        if (! in_array($rec->status, ['active', 'snoozed'], true) || ! is_array($action) || ($action['kind'] ?? null) !== 'proposal') {
            throw ValidationException::withMessages(['recommendation' => ['This suggestion has no change to propose.']]);
        }
        $ar = ($user->preferences()['language'] ?? 'en') === 'ar';
        $proposal = match ($action['proposal']) {
            'find_time' => $this->actions->proposeFindTime($user, Task::where('user_id', $user->id)->whereIn('id', (array) ($action['task_ids'] ?? []))->whereNotIn('status', ['completed', 'cancelled'])->get(),
                $rec->payload['title'][$ar ? 'ar' : 'en'], $ar, 'local'),
            'rebalance' => $this->actions->proposeRebalance($user, $ar, 'local'),
            default => throw ValidationException::withMessages(['recommendation' => ['This suggestion has no change to propose.']]),
        };
        if ($proposal->actions === []) {
            throw ValidationException::withMessages(['recommendation' => [$ar ? 'لم يُعثر على وقت مناسب الآن. جرّب تعديل يومك أو مواعيدك.' : 'No suitable time was found right now. Try adjusting your day or deadlines.']]);
        }
        $rec->forceFill(['status' => 'acted', 'acted_at' => now(), 'proposal_id' => $proposal->id])->save();
        $this->audit->log($user, 'recommendation_acted', $request, ['type' => $rec->type, 'proposal' => $proposal->id]);

        return $proposal;
    }

    /**
     * Types the user keeps marking "not useful" (only with opt-in personalization).
     *
     * @return list<string>
     */
    public function quietTypes(User $user): array
    {
        if (! IntelligenceSettings::for($user)['personalization']) {
            return [];
        }

        return Recommendation::where('user_id', $user->id)->whereNotNull('feedback')->get(['type', 'feedback'])->groupBy('type')
            ->filter(function (Collection $rows) {
                $no = $rows->where('feedback', 'not_useful')->count();

                return $no >= self::QUIET_AFTER && $no > $rows->where('feedback', 'useful')->count();
            })->keys()->values()->all();
    }

    /**
     * @return Collection<int, array<string, mixed>>
     */
    public function candidates(User $user): Collection
    {
        $snap = $this->intelligence->snapshot($user);
        $tz = $snap['timezone'];
        $now = CarbonImmutable::now($tz);
        $time = fn (?string $iso) => $iso ? CarbonImmutable::parse($iso)->setTimezone($tz)->locale('en')->isoFormat('ddd HH:mm') : '';
        $timeAr = fn (?string $iso) => $iso ? CarbonImmutable::parse($iso)->setTimezone($tz)->locale('ar')->isoFormat('dddd HH:mm') : '';
        $out = collect();

        // Approaching deadlines without time set aside (or at risk of not fitting).
        foreach ($snap['priorities'] as $p) {
            if (! $p['due_at'] || $p['scheduled'] || ! in_array($p['risk'], ['high', 'medium'], true)) {
                continue;
            }
            $due = CarbonImmutable::parse($p['due_at']);
            if ($due->isPast() || $due->gt($now->addHours(48))) {
                continue;
            }
            $risky = in_array('deadline_risk', $p['reasons'], true);
            $out->push(['key' => "deadline:{$p['id']}:".$due->toDateString(), 'type' => 'deadline', 'severity' => $risky || $due->lte($now->addHours(24)) ? 'high' : 'medium',
                'title' => ['en' => "“{$p['title']}” is due {$time($p['due_at'])}", 'ar' => "«{$p['title']}» مستحقة {$timeAr($p['due_at'])}"],
                'detail' => $risky
                    ? ['en' => 'It may not fit around your other commitments, and no time is set aside for it yet.', 'ar' => 'قد لا تتسع حول التزاماتك الأخرى، ولم يُخصص لها وقت بعد.']
                    : ['en' => 'No time is set aside for it yet.', 'ar' => 'لم يُخصص لها وقت بعد.'],
                'confidence' => $p['confidence'], 'sources' => $p['sources'], 'evidence' => ['due_at' => $p['due_at'], 'estimated_minutes' => $p['estimated_minutes'], 'reasons' => $p['reasons']],
                'subject' => ['task_id' => $p['id']],
                'action' => ['kind' => 'proposal', 'proposal' => 'find_time', 'task_ids' => [$p['id']], 'label' => ['en' => 'Find time', 'ar' => 'اعثر على وقت']]]);
        }

        // Scheduling conflicts (overlaps and planned work during meetings).
        foreach ($snap['conflicts']->take(5) as $c) {
            $ids = $c['items'];
            sort($ids);
            $date = CarbonImmutable::parse($c['at'])->setTimezone($tz)->toDateString();
            $out->push(['key' => 'conflict:'.implode(',', $ids), 'type' => 'conflict', 'severity' => 'high',
                'title' => ['en' => "“{$c['titles'][0]}” overlaps “{$c['titles'][1]}”", 'ar' => "«{$c['titles'][0]}» يتداخل مع «{$c['titles'][1]}»"],
                'detail' => ['en' => "{$c['minutes']} minutes overlap on {$time($c['at'])}.", 'ar' => "تداخل {$c['minutes']} دقيقة {$timeAr($c['at'])}."],
                'confidence' => 'high', 'sources' => array_values(array_unique(array_merge(['calendar'], $c['sources'] ?? []))), 'evidence' => ['items' => $c['items'], 'minutes' => $c['minutes']],
                'subject' => ['date' => $date], 'action' => ['kind' => 'link', 'to' => "/timeline?date={$date}", 'label' => ['en' => 'Open timeline', 'ar' => 'فتح الخط الزمني']]]);
        }

        // Overloaded working days in the next five days.
        foreach ($snap['workload']->take(5) as $d) {
            if (! $d['work_day'] || $d['load_percent'] < 100) {
                continue;
            }
            $out->push(['key' => "overload:{$d['date']}", 'type' => 'overload', 'severity' => $d['load_percent'] >= 120 ? 'high' : 'medium',
                'title' => ['en' => CarbonImmutable::parse($d['date'])->locale('en')->isoFormat('dddd D MMM')." is {$d['load_percent']}% booked", 'ar' => CarbonImmutable::parse($d['date'])->locale('ar')->isoFormat('dddd D MMM')." محجوز بنسبة {$d['load_percent']}٪"],
                'detail' => ['en' => 'Moving a flexible block to a lighter day keeps the plan realistic.', 'ar' => 'نقل فترة مرنة إلى يوم أخف يجعل الخطة واقعية.'],
                'confidence' => 'high', 'sources' => ['calendar'], 'evidence' => ['committed_minutes' => $d['committed_minutes'], 'capacity_minutes' => $d['capacity_minutes']],
                'subject' => ['date' => $d['date']], 'action' => ['kind' => 'proposal', 'proposal' => 'rebalance', 'label' => ['en' => 'Suggest a rebalance', 'ar' => 'اقترح إعادة توازن']]]);
        }

        // Goals falling behind.
        foreach ($snap['goals']->take(3) as $g) {
            $out->push(['key' => "goal:{$g['id']}:".$now->startOfWeek()->toDateString(), 'type' => 'goal', 'severity' => $g['status'] === 'behind' ? 'medium' : 'high',
                'title' => ['en' => "“{$g['title']}” needs attention", 'ar' => "«{$g['title']}» يحتاج إلى اهتمام"],
                'detail' => $g['reasons'][0] ?? ['en' => 'Progress is behind schedule.', 'ar' => 'التقدم متأخر عن الجدول.'],
                'confidence' => $g['confidence'], 'sources' => $g['sources'], 'evidence' => ['status' => $g['status'], 'percent' => $g['percent']],
                'subject' => ['goal_id' => $g['id']], 'action' => ['kind' => 'link', 'to' => '/assistant?ask='.rawurlencode("Plan my goal {$g['title']}"), 'label' => ['en' => 'Plan next steps', 'ar' => 'خطط للخطوات التالية']]]);
        }

        // Work that keeps getting pushed back.
        foreach ($snap['postponed']->take(3) as $t) {
            $out->push(['key' => "postponed:{$t['id']}:{$t['postponed_count']}", 'type' => 'postponed', 'severity' => $t['postponed_count'] >= 4 ? 'high' : 'medium',
                'title' => ['en' => "“{$t['title']}” has been postponed {$t['postponed_count']} times", 'ar' => "أُجّلت «{$t['title']}» {$t['postponed_count']} مرات"],
                'detail' => ['en' => 'Block a short slot to start it, split it into smaller steps, or decide to drop it.', 'ar' => 'خصص وقتاً قصيراً للبدء، أو قسّمها إلى خطوات أصغر، أو قرر إلغاءها.'],
                'confidence' => 'high', 'sources' => ['tasks'], 'evidence' => ['postponed_count' => $t['postponed_count']],
                'subject' => ['task_id' => $t['id']], 'action' => ['kind' => 'proposal', 'proposal' => 'find_time', 'task_ids' => [$t['id']], 'label' => ['en' => 'Find time', 'ar' => 'اعثر على وقت']]]);
        }

        // A good focus window today, while no focus has happened yet.
        $top = $snap['priorities']->first(fn ($p) => ! $p['scheduled']);
        $window = $snap['focus_windows']->first(fn ($w) => $w['minutes'] >= 60);
        if ($top && $window && in_array('focus', $snap['sources'], true) && $this->intelligence->focusToday($user, $now->startOfDay()) === 0) {
            $out->push(['key' => 'focus:'.$now->toDateString().':'.$window['starts_at'], 'type' => 'focus', 'severity' => 'low',
                'title' => ['en' => "{$window['minutes']} free minutes from {$time($window['starts_at'])}", 'ar' => "{$window['minutes']} دقيقة متاحة من {$timeAr($window['starts_at'])}"],
                'detail' => ['en' => "A good window for “{$top['title']}”, your top priority.", 'ar' => "وقت مناسب لـ «{$top['title']}»، أولويتك القصوى."],
                'confidence' => $snap['focus_capacity']['confidence'], 'sources' => ['calendar', 'tasks', 'focus'], 'evidence' => ['window' => $window, 'task_id' => $top['id']],
                'subject' => ['task_id' => $top['id']], 'action' => ['kind' => 'link', 'to' => "/focus?task={$top['id']}", 'label' => ['en' => 'Start focus', 'ar' => 'ابدأ التركيز']]]);
        }

        return $out->values();
    }

    /** With the "daily" frequency, one in-app/push digest per day when there is something important. */
    private function notify(User $user): void
    {
        if (IntelligenceSettings::for($user)['frequency'] !== 'daily') {
            return;
        }
        $high = Recommendation::where('user_id', $user->id)->where('status', 'active')->where('severity', 'high')->count();
        if ($high === 0) {
            return;
        }
        $ar = ($user->preferences()['language'] ?? 'en') === 'ar';
        $this->notifier->send($user, 'planning', 'recommendations:'.$user->id.':'.CarbonImmutable::now($user->timezone())->toDateString(),
            $ar ? "لديك {$high} اقتراحات مهمة اليوم." : "{$high} important suggestion(s) for today.", ['link' => '/', 'kind' => 'recommendations']);
    }

    /**
     * Delete recommendation history older than the user's retention period.
     */
    public function prune(User $user): int
    {
        $days = (int) IntelligenceSettings::for($user)['retention_days'];

        return Recommendation::where('user_id', $user->id)->where('updated_at', '<', now()->subDays($days))->delete();
    }
}
