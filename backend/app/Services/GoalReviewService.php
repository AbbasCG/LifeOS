<?php

namespace App\Services;

use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\GoalReview;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;

/**
 * Monthly goal reviews. A review states what happened to a goal in a month — progress and its change since the
 * previous review, linked tasks completed, focus time, milestones, pace against the deadline — and proposes the next
 * step as a pending Copilot proposal (time for its open tasks, or tasks from its milestones). Nothing changes until
 * the user approves. Each review stores a small snapshot (goal_reviews) so the next one can show the change.
 *
 * Reviews are asked for from a goal ("Review this month": the month so far) or, opt-in, prepared on the 1st of each
 * month for the month that just ended (one overview conversation with a button per goal).
 */
class GoalReviewService
{
    public const FEATURE = 'goal_reviews';

    /** Local hour on the 1st of the month from which the scheduled review is prepared. */
    public const HOUR = 9;

    /** At most this many goals in one monthly overview (those needing attention first). */
    public const MAX_GOALS = 8;

    private const STATUS_ORDER = ['overdue' => 0, 'at_risk' => 1, 'behind' => 2, 'on_track' => 3, 'no_deadline' => 4, 'completed' => 5];

    public function __construct(private GoalIntelligence $goals, private AssistantActions $actions, private ConversationService $conversations, private Notifier $notifier, private AuditLogger $audit) {}

    /**
     * The month a review covers: the current month so far, or (scheduled) the month that just ended.
     *
     * @return array{0: CarbonImmutable, 1: CarbonImmutable}
     */
    public static function period(User $user, bool $previousMonth = false): array
    {
        $now = CarbonImmutable::now($user->timezone());
        $start = $now->startOfMonth()->subMonths($previousMonth ? 1 : 0);

        return [$start, $previousMonth ? $start->endOfMonth() : $now];
    }

    /**
     * Review one goal for a period: the facts, a snapshot for next time, and the proposed next step.
     *
     * @return array<string, mixed> an assistant reply (message, proposal, intent, provider, context)
     */
    public function reply(User $user, Goal $goal, bool $ar, bool $previousMonth = false): array
    {
        [$from, $to] = self::period($user, $previousMonth);
        $facts = $this->facts($user, $goal, $from, $to);
        $month = $from->locale($ar ? 'ar' : 'en')->translatedFormat('F Y');
        $lines = [$ar ? "مراجعة «{$this->isolate($goal->title)}» — {$month}" : "Review of “{$goal->title}” — {$month}"];
        $lines[] = $facts['previous'] === null
            ? ($ar ? "• التقدم: {$facts['percent']}٪. هذه أول مراجعة؛ ستُظهر المراجعة القادمة التغيّر." : "• Progress: {$facts['percent']}%. This is the first review; the next one will show the change.")
            : ($ar ? "• التقدم: {$facts['percent']}٪ (".self::signed($facts['change']).'٪ منذ مراجعة '.$facts['previous']['month_ar'].').'
                : "• Progress: {$facts['percent']}% (".self::signed($facts['change']).'% since the '.$facts['previous']['month_en'].' review).');
        $lines[] = $ar ? "• أُنجزت {$facts['tasks_done']} مهمة مرتبطة، و{$facts['focus_minutes']} دقيقة تركيز عليها."
            : "• {$facts['tasks_done']} linked task(s) completed and {$facts['focus_minutes']} focus minute(s) on them.";
        if ($facts['milestones']['total'] > 0) {
            $lines[] = $ar ? "• المراحل: {$facts['milestones']['done']} من {$facts['milestones']['total']}." : "• Milestones: {$facts['milestones']['done']} of {$facts['milestones']['total']}.";
        }
        $lines[] = $ar ? "• مفتوحة الآن: {$facts['open']} مهمة".($facts['overdue'] ? "، منها {$facts['overdue']} متأخرة." : '.')
            : "• Open now: {$facts['open']} task(s)".($facts['overdue'] ? ", {$facts['overdue']} overdue." : '.');
        if ($facts['pace'] !== null) {
            $lines[] = $ar ? "• للوصول في الموعد: نحو {$facts['pace']}٪ شهرياً حتى ".$facts['due']->toDateString().'.'
                : "• To finish on time: about {$facts['pace']}% a month until ".$facts['due']->toDateString().'.';
        }
        $lines[] = '• '.implode(' ', array_map(fn (array $r) => $r[$ar ? 'ar' : 'en'], $facts['reasons']));

        $proposal = null;
        if ($facts['status'] === 'completed') {
            $lines[] = $ar ? 'تم بلوغ المستهدف — لا خطوة تالية مقترحة.' : 'Target reached — no next step proposed.';
        } else {
            $open = BriefingService::rank(Task::where('user_id', $user->id)->where('goal_id', $goal->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(50)->get(), CarbonImmutable::now($user->timezone()))->pluck('task')->take(3);
            $proposal = $open->isNotEmpty()
                ? $this->actions->proposeFindTime($user, $open, $ar ? "«{$this->isolate($goal->title)}»" : "“{$goal->title}”", $ar, 'local')
                : $this->actions->proposeGoalPlan($user, $goal, [], $ar, 'local');
            $lines[] = $open->isNotEmpty()
                ? ($ar ? 'الخطوة التالية المقترحة: وقت هذا الأسبوع لأهم المهام المفتوحة لهذا الهدف.' : 'Proposed next step: time this week for the goal’s most important open tasks.')
                : ($ar ? 'الخطوة التالية المقترحة: مهام مؤرخة لهذا الهدف.' : 'Proposed next step: dated tasks for this goal.');
            $lines[] = $ar ? 'لا يتغير شيء حتى توافق.' : 'Nothing changes until you approve.';
        }
        self::snapshot($user, $goal, $from, $to, $facts);

        return ['message' => implode("\n", $lines), 'proposal' => $proposal?->present(), 'intent' => 'goal_review', 'provider' => 'local',
            'context' => ['shared' => false, 'sources' => [['source' => 'goals'], ['source' => 'tasks'], ['source' => 'focus']]]];
    }

    /**
     * What happened to a goal in a period.
     *
     * @return array{percent: int, change: int|null, previous: array{month_en: string, month_ar: string}|null, tasks_done: int, focus_minutes: int, open: int, overdue: int, milestones: array{done: int, total: int}, status: string, reasons: list<array{en: string, ar: string}>, pace: int|null, due: CarbonImmutable|null}
     */
    public function facts(User $user, Goal $goal, CarbonImmutable $from, CarbonImmutable $to): array
    {
        $health = $this->goals->goals($user)->firstWhere('id', $goal->id) ?? [];
        $linked = Task::where('user_id', $user->id)->where('goal_id', $goal->id)->get(['id', 'status', 'due_at', 'completed_at']);
        $done = $linked->filter(fn (Task $t) => $t->completed_at && $t->completed_at >= $from->utc() && $t->completed_at <= $to->utc())->count();
        $focus = (int) floor(FocusSession::where('user_id', $user->id)->where('status', 'completed')->whereIn('task_id', $linked->pluck('id'))
            ->whereBetween('completed_at', [$from->utc(), $to->utc()])->sum('elapsed_seconds') / 60);
        $open = $linked->whereNotIn('status', ['completed', 'cancelled']);
        $percent = (int) ($health['percent'] ?? min(100, round($goal->progress / max(1, $goal->target) * 100)));
        $previous = GoalReview::where('goal_id', $goal->id)->whereDate('period_start', '<', $from->toDateString())->latest('period_start')->first();
        $due = $goal->due_at ? CarbonImmutable::instance($goal->due_at)->setTimezone($user->timezone()) : null;
        $daysLeft = $due ? (int) floor(CarbonImmutable::now($user->timezone())->diffInDays($due, false)) : null;

        return [
            'percent' => $percent, 'change' => $previous ? $percent - $previous->percent : null,
            'previous' => $previous ? ['month_en' => $previous->period_start->locale('en')->translatedFormat('F'), 'month_ar' => $previous->period_start->locale('ar')->translatedFormat('F')] : null,
            'tasks_done' => $done, 'focus_minutes' => $focus, 'open' => $open->count(), 'overdue' => $open->filter(fn (Task $t) => $t->due_at?->isPast())->count(),
            'milestones' => ['done' => (int) ($health['milestones']['done'] ?? 0), 'total' => (int) ($health['milestones']['total'] ?? 0)],
            'status' => (string) ($health['status'] ?? 'no_deadline'), 'reasons' => array_values($health['reasons'] ?? []),
            'pace' => $daysLeft !== null && $daysLeft > 0 && $percent < 100 ? (int) ceil((100 - $percent) / max(1, ceil($daysLeft / 30))) : null, 'due' => $due,
        ];
    }

    /**
     * Review one goal now (the month so far) as a new Copilot conversation.
     *
     * @return array<string, mixed>
     */
    public function reviewGoal(User $user, Goal $goal, string $language, ?Request $request = null): array
    {
        $ar = $language === 'ar';
        $seeded = $this->conversations->seed($user, $ar ? "راجع هدفي «{$this->isolate($goal->title)}» لهذا الشهر" : "Review my goal “{$goal->title}” this month", $language, $this->reply($user, $goal, $ar));
        $this->audit->log($user, 'goal_reviewed', $request, ['scheduled' => false, 'proposal' => isset($seeded['message']['proposal'])]);

        return $seeded;
    }

    /**
     * Goals worth reviewing (not yet completed), those needing attention first.
     *
     * @return Collection<int, Goal>
     */
    private function reviewable(User $user): Collection
    {
        $health = $this->goals->goals($user)->keyBy('id');

        return Goal::where('user_id', $user->id)->limit(200)->get()
            ->filter(fn (Goal $g) => ($health[$g->id]['status'] ?? null) !== 'completed')
            ->sortBy(fn (Goal $g) => [self::STATUS_ORDER[$health[$g->id]['status'] ?? 'no_deadline'] ?? 9, $g->due_at?->getTimestamp() ?? PHP_INT_MAX])
            ->take(self::MAX_GOALS)->values();
    }

    /**
     * Whether the scheduled monthly review is due: reviews are on, it is the 1st (from 09:00 local), and the month
     * that just ended was not reviewed yet.
     */
    public function due(User $user): bool
    {
        if (! IntelligenceSettings::feature($user, self::FEATURE)) {
            return false;
        }
        $now = CarbonImmutable::now($user->timezone());

        return $now->day === 1 && $now->hour >= self::HOUR && ($user->preferences()['goal_review_last'] ?? null) !== $now->subMonth()->format('Y-m');
    }

    /**
     * The monthly overview for the month that just ended: one line per goal (each also snapshotted), with a button to
     * open the full review and proposed next step of any goal. Notifies once.
     *
     * @return array<string, mixed>|null the seeded conversation, or null when there are no goals
     */
    public function prepareMonthly(User $user, string $language): ?array
    {
        $ar = $language === 'ar';
        [$from, $to] = self::period($user, true);
        $setting = UserSetting::firstOrCreate(['user_id' => $user->id], ['preferences' => []]);
        $setting->update(['preferences' => array_merge($setting->preferences ?? [], ['goal_review_last' => $from->format('Y-m')])]);
        $goals = $this->reviewable($user);
        if ($goals->isEmpty()) {
            return null;
        }
        $month = $from->locale($ar ? 'ar' : 'en')->translatedFormat('F Y');
        $status = ['overdue' => ['overdue', 'متأخر'], 'at_risk' => ['at risk', 'في خطر'], 'behind' => ['behind', 'متأخر عن الوتيرة'], 'on_track' => ['on track', 'على المسار'], 'no_deadline' => ['no deadline', 'بلا موعد'], 'completed' => ['completed', 'مكتمل']];
        $lines = [$ar ? "مراجعة أهدافك لشهر {$month}:" : "Your goal review for {$month}:"];
        foreach ($goals as $goal) {
            $f = $this->facts($user, $goal, $from, $to);
            self::snapshot($user, $goal, $from, $to, $f);
            $change = $f['change'] === null ? '' : ' ('.self::signed($f['change']).($ar ? '٪)' : '%)');
            $label = $status[$f['status']][$ar ? 1 : 0] ?? $f['status'];
            $lines[] = $ar ? "• «{$this->isolate($goal->title)}»: {$f['percent']}٪{$change} · {$label} · {$f['tasks_done']} مهمة · {$f['focus_minutes']} دقيقة تركيز"
                : "• “{$goal->title}”: {$f['percent']}%{$change} · {$label} · {$f['tasks_done']} task(s) · {$f['focus_minutes']} focus min";
        }
        $lines[] = $ar ? 'اختر هدفاً لرؤية مراجعته الكاملة والخطوة التالية المقترحة. لا يتغير شيء حتى توافق.' : 'Pick a goal to see its full review and a proposed next step. Nothing changes until you approve.';
        $result = ['message' => implode("\n", $lines), 'intent' => 'goal_review', 'provider' => 'local',
            'clarify' => ['intent' => 'goal_review', 'slot' => 'goal', 'options' => $goals->map(fn (Goal $g) => ['value' => (string) $g->id, 'label' => ['en' => "Review “{$g->title}”", 'ar' => "راجع «{$this->isolate($g->title)}»"]])->values()->all()],
            'state' => ['intent' => 'goal_review', 'slots' => ['previous_month' => true], 'awaiting' => 'goal'],
            'context' => ['shared' => false, 'sources' => [['source' => 'goals'], ['source' => 'tasks'], ['source' => 'focus']]]];
        $seeded = $this->conversations->seed($user, $ar ? "مراجعة الأهداف الشهرية ({$month})" : "Monthly goal review ({$month})", $language, $result);
        $this->notifier->send($user, 'review', "goal-review:{$user->id}:{$from->format('Y-m')}", $ar ? "مراجعة أهدافك لشهر {$month} جاهزة" : "Your goal review for {$month} is ready",
            ['body' => $ar ? 'تقدّم كل هدف وما أُنجز، مع خطوة تالية مقترحة لكل هدف.' : 'Each goal’s progress and what got done, with a proposed next step for each.', 'link' => '/assistant?c='.$seeded['conversation']['id'], 'kind' => 'goal_review']);
        $this->audit->log($user, 'goal_reviewed', null, ['scheduled' => true, 'goals' => $goals->count()]);

        return $seeded;
    }

    /**
     * Store (or refresh) the goal's snapshot for this month.
     *
     * @param  array{percent: int, tasks_done: int, focus_minutes: int, status: string}  $facts
     */
    private static function snapshot(User $user, Goal $goal, CarbonImmutable $from, CarbonImmutable $to, array $facts): void
    {
        $review = GoalReview::where('goal_id', $goal->id)->whereDate('period_start', $from->toDateString())->first() ?? new GoalReview(['goal_id' => $goal->id, 'period_start' => $from->toDateString()]);
        $review->fill(['user_id' => $user->id, 'period_end' => $to->toDateString(), 'percent' => $facts['percent'], 'tasks_done' => $facts['tasks_done'],
            'focus_minutes' => $facts['focus_minutes'], 'status' => $facts['status']])->save();
    }

    /**
     * Keep a title in its own writing direction inside Arabic text, so an English title is not reordered.
     */
    private function isolate(string $title): string
    {
        return "\u{2068}{$title}\u{2069}";
    }

    private static function signed(int $n): string
    {
        return $n > 0 ? "+{$n}" : (string) $n;
    }
}
