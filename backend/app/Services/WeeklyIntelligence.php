<?php

namespace App\Services;

use App\Integrations\Ai\AiException;
use App\Models\User;
use Carbon\CarbonImmutable;
use Throwable;

/**
 * Weekly intelligence on top of the weekly review: measured facts, rule-based interpretations that cite the facts they
 * rest on, workload patterns, and suggestions for next week. An AI-written summary is optional (separate switch plus
 * the external-AI consent), receives numbers only, and is always labelled; if it is off or fails, a deterministic
 * summary is used instead.
 */
class WeeklyIntelligence
{
    public function __construct(private PlanningService $planning, private AssistantService $assistant) {}

    /**
     * @param  array<string, mixed>  $review  WeeklyReviewService::build() output
     * @return array<string, mixed>
     */
    public function build(User $user, CarbonImmutable $start, array $review): array
    {
        if (! IntelligenceSettings::feature($user, 'weekly')) {
            return ['enabled' => false];
        }
        $m = $review['metrics'];
        $totals = $review['planned_vs_actual']['totals'] ?? [];
        $c = $this->planning->config($user);
        $week = collect($this->planning->summary($user, $start, 7, [], [], $c)['days']);
        $completedByDay = collect($review['completed'])->countBy(fn ($t) => $t['completed_at'] ? CarbonImmutable::parse($t['completed_at'])->setTimezone($c['tz'])->toDateString() : null);
        $focusByDay = collect($review['focus_by_day'])->keyBy('date');
        $workload = $week->map(fn (array $d) => ['date' => $d['date'], 'committed_minutes' => $d['fixed_minutes'] + $d['existing_flexible_minutes'], 'capacity_minutes' => $d['capacity_minutes'],
            'load_percent' => $d['load_percent'], 'focus_minutes' => (int) ($focusByDay[$d['date']]['minutes'] ?? 0), 'completed' => (int) ($completedByDay[$d['date']] ?? 0)])->values();

        $facts = [
            ['key' => 'completed', 'value' => $m['completed'], 'unit' => 'tasks', 'source' => 'tasks'],
            ['key' => 'unfinished', 'value' => $m['unfinished'], 'unit' => 'tasks', 'source' => 'tasks'],
            ['key' => 'focus_minutes', 'value' => $m['focus_minutes'], 'unit' => 'minutes', 'source' => 'focus', 'previous' => $m['previous_focus_minutes'], 'change_percent' => $m['focus_change']],
            ['key' => 'on_time_rate', 'value' => $m['on_time_rate'], 'unit' => 'percent', 'source' => 'tasks'],
            ['key' => 'estimate_overruns', 'value' => $m['estimate_overruns'], 'unit' => 'tasks', 'source' => 'tasks'],
            ['key' => 'habit_consistency', 'value' => $m['habit_consistency'], 'unit' => 'percent', 'source' => 'habits'],
            ['key' => 'plan_follow_through', 'value' => isset($totals['ratio']) ? (int) round($totals['ratio'] * 100) : null, 'unit' => 'percent', 'source' => 'planner'],
            ['key' => 'goals_needing_attention', 'value' => collect($review['goal_health'])->whereIn('status', ['at_risk', 'behind', 'overdue'])->count(), 'unit' => 'goals', 'source' => 'goals'],
        ];
        $fact = fn (string $key) => collect($facts)->firstWhere('key', $key)['value'] ?? null;

        $interpretations = [];
        $add = function (string $key, string $en, string $ar, array $evidence, string $confidence) use (&$interpretations): void {
            $interpretations[] = compact('key', 'en', 'ar', 'evidence', 'confidence') + ['kind' => 'rule'];
        };
        if ($m['focus_change'] !== null && abs($m['focus_change']) >= 20 && $m['previous_focus_minutes'] >= 60) {
            $up = $m['focus_change'] > 0;
            $add('focus_trend', $up ? "Focus time rose {$m['focus_change']}% compared with last week." : 'Focus time fell '.abs($m['focus_change']).'% compared with last week.',
                $up ? "ارتفع وقت التركيز {$m['focus_change']}٪ مقارنة بالأسبوع الماضي." : 'انخفض وقت التركيز '.abs($m['focus_change']).'٪ مقارنة بالأسبوع الماضي.', ['focus_minutes'], 'high');
        }
        $busiest = $workload->sortByDesc('committed_minutes')->first();
        if ($busiest && $busiest['committed_minutes'] >= 240 && $busiest['focus_minutes'] < 30 && $workload->sum('focus_minutes') >= 60) {
            $day = CarbonImmutable::parse($busiest['date']);
            $add('busy_day_focus', "Your most booked day ({$day->locale('en')->isoFormat('dddd')}) had almost no focus time. Days with many commitments may leave little room for deep work.",
                "يومك الأكثر حجزاً ({$day->locale('ar')->isoFormat('dddd')}) كاد يخلو من وقت التركيز. قد تترك الأيام المليئة بالالتزامات مساحة قليلة للعمل العميق.", ['workload', 'focus_minutes'], 'medium');
        }
        if ($m['on_time_rate'] !== null && $m['on_time_rate'] < 60 && $m['completed'] >= 3) {
            $add('deadlines_slipped', "Only {$m['on_time_rate']}% of completed tasks with a deadline were on time. Deadlines may be set tighter than the available time.",
                "اكتملت {$m['on_time_rate']}٪ فقط من المهام ذات المواعيد في وقتها. قد تكون المواعيد أضيق من الوقت المتاح.", ['on_time_rate'], $m['completed'] >= 8 ? 'medium' : 'low');
        }
        if ($m['estimate_overruns'] >= 2) {
            $add('estimates', "{$m['estimate_overruns']} tasks took over 30% longer than estimated. Adding a buffer to estimates may make plans more realistic.",
                "استغرقت {$m['estimate_overruns']} مهام أكثر من تقديرها بـ ٣٠٪. قد تجعل إضافة هامش للتقديرات الخطط أكثر واقعية.", ['estimate_overruns'], 'medium');
        }
        if (($fact('plan_follow_through') ?? 100) < 60 && ($totals['planned_minutes'] ?? 0) >= 120) {
            $add('plan_follow_through', "About {$fact('plan_follow_through')}% of planned focus time happened. Plans may be more ambitious than your weeks allow.",
                "تحقق نحو {$fact('plan_follow_through')}٪ من وقت التركيز المخطط. قد تكون الخطط أطمح مما تسمح به أسابيعك.", ['plan_follow_through'], 'medium');
        }
        if ($m['habit_consistency'] !== null && $m['habit_consistency'] >= 80) {
            $add('habits_strong', "Habits held at {$m['habit_consistency']}% consistency — a strong week.", "حافظت العادات على التزام {$m['habit_consistency']}٪ — أسبوع قوي.", ['habit_consistency'], 'high');
        }

        $next = collect($this->planning->summary($user, $start->addDays(7), 7, [], [], $c)['days'])->filter(fn ($d) => $d['work_day'] && $d['overloaded']);
        $suggestions = [];
        foreach ($review['suggested_priorities'] as $p) {
            if (count($suggestions) >= 3) {
                break;
            }
            $suggestions[] = ['key' => "priority:{$p['id']}", 'en' => "Start next week with “{$p['title']}”.", 'ar' => "ابدأ الأسبوع القادم بـ «{$p['title']}».", 'link' => "/focus?task={$p['id']}"];
        }
        foreach ($next->take(2) as $d) {
            $suggestions[] = ['key' => "overload:{$d['date']}", 'en' => CarbonImmutable::parse($d['date'])->locale('en')->isoFormat('dddd')." next week is already {$d['load_percent']}% booked — plan around it.", 'ar' => CarbonImmutable::parse($d['date'])->locale('ar')->isoFormat('dddd')." الأسبوع القادم محجوز بنسبة {$d['load_percent']}٪ — خطط حوله.", 'link' => '/planning'];
        }
        if (collect($interpretations)->contains('key', 'estimates')) {
            $suggestions[] = ['key' => 'buffer', 'en' => 'Add about 30% to estimates for similar tasks next week.', 'ar' => 'أضف نحو ٣٠٪ إلى تقديرات المهام المشابهة الأسبوع القادم.', 'link' => null];
        }

        return ['enabled' => true, 'facts' => $facts, 'interpretations' => $interpretations, 'workload' => $workload, 'suggestions' => $suggestions,
            'narrative_available' => IntelligenceSettings::feature($user, 'ai_narrative') && $this->assistant->provider($user) !== null];
    }

    /**
     * A short summary of the week. AI-written only when allowed and configured (numbers only are sent); otherwise, or
     * if the provider fails, a deterministic summary of the same facts.
     *
     * @param  array<string, mixed>  $intelligence  build() output
     * @return array<string, mixed>
     */
    public function narrative(User $user, array $intelligence, bool $ar): array
    {
        $rules = $this->rules($intelligence, $ar);
        if (! IntelligenceSettings::feature($user, 'ai_narrative')) {
            return $rules + ['fallback_reason' => 'disabled'];
        }
        $provider = $this->assistant->provider($user);
        if (! $provider) {
            return $rules + ['fallback_reason' => 'not_available'];
        }
        $input = json_encode(['language' => $ar ? 'ar' : 'en', 'facts' => collect($intelligence['facts'])->map(fn ($f) => array_intersect_key($f, array_flip(['key', 'value', 'unit', 'previous', 'change_percent'])))->values(),
            'observations' => collect($intelligence['interpretations'])->pluck('key')->values()]);
        try {
            $out = $provider->json(
                'You summarise a person\'s week for them in 2-3 short, kind, factual sentences in the requested language. Use only the numbers given. Do not invent events, causes, feelings or advice beyond the observations listed. No medical or personal judgements.',
                (string) $input,
                ['type' => 'object', 'additionalProperties' => false, 'required' => ['summary'], 'properties' => ['summary' => ['type' => 'string', 'maxLength' => 600]]],
            );
            $summary = trim((string) ($out['summary'] ?? ''));
            if ($summary === '') {
                throw new AiException('Empty summary.');
            }

            return ['kind' => 'ai', 'provider' => $provider->label(), 'text' => mb_substr($summary, 0, 600)];
        } catch (Throwable $e) {
            report($e);

            return $rules + ['fallback_reason' => 'provider_error'];
        }
    }

    /**
     * @param  array<string, mixed>  $intelligence
     * @return array{kind: string, text: string}
     */
    private function rules(array $intelligence, bool $ar): array
    {
        $f = collect($intelligence['facts'])->keyBy('key');
        $parts = [$ar
            ? "أنجزت {$f['completed']['value']} مهمة وركّزت ".$f['focus_minutes']['value'].' دقيقة هذا الأسبوع.'
            : "You completed {$f['completed']['value']} task(s) and focused for {$f['focus_minutes']['value']} minutes this week."];
        foreach (array_slice($intelligence['interpretations'], 0, 2) as $i) {
            $parts[] = $i[$ar ? 'ar' : 'en'];
        }

        return ['kind' => 'rules', 'text' => implode(' ', $parts)];
    }
}
