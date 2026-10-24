<?php

namespace App\Services;

use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * Connects long-term goals to daily execution using the user's own history: pace against deadlines, milestones,
 * linked-task activity and focus time. Every status carries bilingual reasons so recommendations are explainable.
 */
class GoalIntelligence
{
    public const WINDOW_DAYS = 14;

    /** Ranking boost for tasks that serve a goal, by goal status. */
    public const PRESSURE = ['overdue' => 30, 'at_risk' => 25, 'behind' => 12, 'deadline_near' => 8];

    public function __construct(private HabitStreaks $streaks) {}

    /**
     * goal_id => boost for task ranking (only goals that need attention).
     *
     * @return array<int, int>
     */
    public function pressure(User $user): array
    {
        return $this->goals($user)->filter(fn (array $g) => isset(self::PRESSURE[$g['pressure_reason'] ?? '']))
            ->mapWithKeys(fn (array $g) => [$g['id'] => self::PRESSURE[$g['pressure_reason']]])->all();
    }

    /**
     * @return Collection<int, array<string, mixed>>
     */
    public function goals(User $user): Collection
    {
        $tz = $user->timezone();
        $now = CarbonImmutable::now($tz);
        $goals = Goal::where('user_id', $user->id)->orderByRaw('due_at IS NULL, due_at ASC')->limit(100)->get();
        if ($goals->isEmpty()) {
            return collect();
        }
        $tasks = Task::where('user_id', $user->id)->whereIn('goal_id', $goals->pluck('id'))->get();
        $focus = FocusSession::where('user_id', $user->id)->where('status', 'completed')->whereIn('task_id', $tasks->pluck('id'))->where('completed_at', '>=', $now->subDays(30)->utc())->get(['task_id', 'elapsed_seconds']);

        return $goals->map(function (Goal $goal) use ($tasks, $focus, $now) {
            $linked = $tasks->where('goal_id', $goal->id);
            $open = $linked->whereNotIn('status', ['completed', 'cancelled']);
            $recent = $linked->filter(fn (Task $t) => $t->completed_at && $t->completed_at >= $now->subDays(self::WINDOW_DAYS))->count();
            $previous = $linked->filter(fn (Task $t) => $t->completed_at && $t->completed_at < $now->subDays(self::WINDOW_DAYS) && $t->completed_at >= $now->subDays(2 * self::WINDOW_DAYS))->count();
            $milestones = collect($goal->milestones ?? []);
            $percent = (int) min(100, round($goal->progress / max(1, $goal->target) * 100));
            $daysLeft = $goal->due_at ? (int) floor($now->diffInDays($goal->due_at, false)) : null;
            $expected = null;
            if ($goal->due_at && $goal->created_at) {
                $span = max(1, $goal->created_at->diffInSeconds($goal->due_at));
                $expected = (int) round(min(1, max(0, $goal->created_at->diffInSeconds($now) / $span)) * 100);
            }
            [$status, $reasons, $pressure] = $this->status($percent, $expected, $daysLeft, $recent, $open->count());
            $nextActions = BriefingService::rank($open->values(), $now)->take(3)->map(fn (array $r) => ['id' => $r['task']->id, 'title' => $r['task']->title, 'priority' => $r['task']->priority, 'due_at' => $r['task']->due_at?->toIso8601String(), 'estimated_minutes' => $r['task']->estimated_minutes])->values();
            $existingTitles = $linked->map(fn (Task $t) => mb_strtolower($t->title))->all();
            $suggested = $milestones->where('completed', false)->filter(fn ($m) => ! in_array(mb_strtolower($m['title']), $existingTitles, true))->take(3)->map(fn ($m) => ['title' => $m['title'], 'source' => 'milestone'])->values();
            $recommendations = [];
            if ($status !== 'completed' && $open->isEmpty()) {
                $recommendations[] = ['type' => 'add_task', 'en' => 'No open task moves this goal forward. Add a concrete next step.', 'ar' => 'لا توجد مهمة مفتوحة تدفع هذا الهدف للأمام. أضف خطوة تالية محددة.'];
            }
            if (in_array($status, ['at_risk', 'behind', 'overdue'], true) && $nextActions->isNotEmpty()) {
                $recommendations[] = ['type' => 'schedule', 'task_id' => $nextActions[0]['id'], 'en' => "Block time for “{$nextActions[0]['title']}” this week.", 'ar' => "احجز وقتاً لـ «{$nextActions[0]['title']}» هذا الأسبوع."];
            }
            if ($daysLeft !== null && $daysLeft < 0 && $percent < 100) {
                $recommendations[] = ['type' => 'adjust', 'en' => 'The deadline has passed. Set a realistic new date or reduce the target.', 'ar' => 'انقضى الموعد النهائي. حدّد موعداً واقعياً جديداً أو خفّض المستهدف.'];
            }

            return [
                'id' => $goal->id, 'title' => $goal->title, 'color' => $goal->color, 'progress' => $goal->progress, 'target' => $goal->target, 'percent' => $percent,
                'due_at' => $goal->due_at?->toIso8601String(), 'days_left' => $daysLeft, 'expected_percent' => $expected,
                'status' => $status, 'reasons' => $reasons, 'pressure_reason' => $pressure,
                'milestones' => ['done' => $milestones->where('completed', true)->count(), 'total' => $milestones->count(), 'next' => $milestones->firstWhere('completed', false)['title'] ?? null],
                'milestone_list' => $milestones->take(12)->map(fn ($m) => ['title' => (string) $m['title'], 'completed' => (bool) ($m['completed'] ?? false)])->values(),
                'tasks' => ['open' => $open->count(), 'done' => $linked->where('status', 'completed')->count(), 'overdue' => $open->filter(fn (Task $t) => $t->due_at?->isPast())->count()],
                'trend' => ['recent' => $recent, 'previous' => $previous, 'direction' => $recent > $previous ? 'up' : ($recent < $previous ? 'down' : 'flat')],
                'focus_minutes_30d' => (int) floor($focus->whereIn('task_id', $linked->pluck('id'))->sum('elapsed_seconds') / 60),
                'next_actions' => $nextActions, 'suggested_tasks' => $suggested, 'recommendations' => $recommendations,
            ];
        })->values();
    }

    /**
     * @return array{0: string, 1: list<array{en: string, ar: string}>, 2: string|null}
     */
    private function status(int $percent, ?int $expected, ?int $daysLeft, int $recentDone, int $openTasks): array
    {
        if ($percent >= 100) {
            return ['completed', [['en' => 'Target reached.', 'ar' => 'تم بلوغ المستهدف.']], null];
        }
        $reasons = [];
        if ($daysLeft !== null && $daysLeft < 0) {
            return ['overdue', [['en' => 'Past its deadline at '.$percent.'%.', 'ar' => 'تجاوز موعده النهائي عند '.$percent.'٪.']], 'overdue'];
        }
        $gap = $expected !== null ? $percent - $expected : null;
        if ($gap !== null) {
            $reasons[] = ['en' => "{$percent}% done with {$expected}% of the time used.", 'ar' => "أُنجز {$percent}٪ مع استهلاك {$expected}٪ من الوقت."];
        }
        if ($recentDone === 0 && $openTasks > 0) {
            $reasons[] = ['en' => 'No linked task completed in the last 14 days.', 'ar' => 'لم تُنجز أي مهمة مرتبطة خلال آخر ١٤ يوماً.'];
        } elseif ($recentDone > 0) {
            $reasons[] = ['en' => "{$recentDone} linked task(s) completed in the last 14 days.", 'ar' => "أُنجزت {$recentDone} مهمة مرتبطة خلال آخر ١٤ يوماً."];
        }
        if ($gap !== null && ($gap <= -20 || ($daysLeft !== null && $daysLeft <= 14 && $percent < 80 && $recentDone === 0))) {
            return ['at_risk', $reasons, 'at_risk'];
        }
        if ($gap !== null && $gap <= -10) {
            return ['behind', $reasons, 'behind'];
        }
        if ($daysLeft === null) {
            return ['no_deadline', $reasons ?: [['en' => 'No deadline set.', 'ar' => 'لا يوجد موعد نهائي.']], null];
        }

        return ['on_track', $reasons, $daysLeft <= 14 ? 'deadline_near' : null];
    }

    /**
     * @return Collection<int, array<string, mixed>>
     */
    public function projects(User $user): Collection
    {
        $now = CarbonImmutable::now($user->timezone());
        $projects = Project::where('user_id', $user->id)->where('status', '!=', 'completed')->limit(100)->get();
        $tasks = Task::where('user_id', $user->id)->whereIn('project_id', $projects->pluck('id'))->get();

        return $projects->map(function (Project $project) use ($tasks, $now) {
            $linked = $tasks->where('project_id', $project->id);
            $open = $linked->whereNotIn('status', ['completed', 'cancelled']);
            $overdue = $open->filter(fn (Task $t) => $t->due_at?->isPast())->count();
            $recent = $linked->filter(fn (Task $t) => $t->completed_at && $t->completed_at >= $now->subDays(self::WINDOW_DAYS))->count();
            $milestones = collect($project->milestones ?? []);
            $milestonePercent = $milestones->count() ? (int) round($milestones->where('completed', true)->count() / $milestones->count() * 100) : null;
            $daysLeft = $project->due_at ? (int) floor($now->diffInDays($project->due_at, false)) : null;
            $reasons = [];
            $score = 0;
            if ($overdue > 0) {
                $score += min(3, $overdue);
                $reasons[] = ['en' => "{$overdue} overdue task(s).", 'ar' => "{$overdue} مهمة متأخرة."];
            }
            if ($project->status === 'active' && $recent === 0 && $open->isNotEmpty()) {
                $score += 2;
                $reasons[] = ['en' => 'No task completed in the last 14 days.', 'ar' => 'لم تُنجز أي مهمة خلال آخر ١٤ يوماً.'];
            }
            if ($daysLeft !== null && $daysLeft < 0) {
                $score += 3;
                $reasons[] = ['en' => 'Past its due date.', 'ar' => 'تجاوز موعد التسليم.'];
            } elseif ($daysLeft !== null && $daysLeft <= 14 && $milestonePercent !== null && $milestonePercent < 50) {
                $score += 2;
                $reasons[] = ['en' => "Due in {$daysLeft} days with {$milestonePercent}% of milestones done.", 'ar' => "يستحق خلال {$daysLeft} يوماً مع إنجاز {$milestonePercent}٪ من المراحل."];
            }
            if ($project->status === 'active' && $open->isEmpty()) {
                $score += 1;
                $reasons[] = ['en' => 'No open tasks — add the next step or mark it complete.', 'ar' => 'لا توجد مهام مفتوحة — أضف الخطوة التالية أو أكمل المشروع.'];
            }
            if ($reasons === []) {
                $reasons[] = ['en' => $recent > 0 ? "{$recent} task(s) completed recently and nothing overdue." : 'Nothing overdue.', 'ar' => $recent > 0 ? "أُنجزت {$recent} مهمة مؤخراً ولا شيء متأخر." : 'لا شيء متأخر.'];
            }

            return [
                'id' => $project->id, 'title' => $project->title, 'color' => $project->color, 'status' => $project->status,
                'health' => $project->status === 'paused' ? 'paused' : ($score >= 4 ? 'at_risk' : ($score >= 2 ? 'attention' : 'healthy')),
                'reasons' => $reasons, 'open' => $open->count(), 'overdue' => $overdue, 'completed_recently' => $recent,
                'milestones' => ['done' => $milestones->where('completed', true)->count(), 'total' => $milestones->count(), 'percent' => $milestonePercent],
                'days_left' => $daysLeft,
            ];
        })->sortByDesc(fn (array $p) => ['at_risk' => 3, 'attention' => 2, 'healthy' => 1, 'paused' => 0][$p['health']])->values();
    }

    /**
     * @return Collection<int, array<string, mixed>>
     */
    public function habits(User $user): Collection
    {
        $today = CarbonImmutable::now($user->timezone())->startOfDay();
        $habits = Habit::where('user_id', $user->id)->limit(100)->get();
        // 12 weeks of history: 60 days for the consistency comparison, 84 for the heatmap.
        $entries = HabitEntry::whereIn('habit_id', $habits->pluck('id'))->where('date', '>=', $today->subDays(83)->toDateString())->get()->groupBy('habit_id');

        return $habits->map(function (Habit $habit) use ($entries, $today) {
            $dates = collect($entries->get($habit->id, []))->map(fn (HabitEntry $e) => substr((string) $e->getRawOriginal('date'), 0, 10));
            $weekly = $habit->recurrence === 'weekly';
            $rate = function (CarbonImmutable $from, CarbonImmutable $to) use ($dates, $weekly) {
                $hits = $dates->filter(fn ($d) => $d >= $from->toDateString() && $d < $to->toDateString());
                $periods = $weekly ? max(1, (int) round($from->diffInDays($to) / 7)) : max(1, (int) $from->diffInDays($to));

                return (int) min(100, round(($weekly ? $hits->map(fn ($d) => CarbonImmutable::parse($d)->startOfWeek()->toDateString())->unique()->count() : $hits->count()) / $periods * 100));
            };
            $current = $rate($today->subDays(29), $today->addDay());
            $previous = $rate($today->subDays(59), $today->subDays(29));
            $stats = $this->streaks->calculate($dates->values()->all(), $habit->recurrence, $today);
            $byWeekday = $dates->filter(fn ($d) => $d >= $today->subDays(59)->toDateString())->countBy(fn ($d) => CarbonImmutable::parse($d)->dayOfWeek)->sortDesc();
            $suggestion = match (true) {
                $current < 40 => ['en' => 'This habit rarely sticks. Make it smaller or tie it to an existing routine.', 'ar' => 'هذه العادة نادراً ما تستمر. صغّرها أو اربطها بروتين قائم.'],
                $current - $previous <= -20 => ['en' => 'Consistency dropped compared with the month before. Restart with a two-day streak.', 'ar' => 'انخفض الالتزام مقارنة بالشهر السابق. ابدأ من جديد بسلسلة يومين.'],
                $stats['current_streak'] >= 3 && ! $stats['done_this_period'] => $weekly
                    ? ['en' => "Keep the {$stats['current_streak']}-week streak alive this week.", 'ar' => "حافظ على سلسلة {$stats['current_streak']} أسابيع هذا الأسبوع."]
                    : ['en' => "Keep the {$stats['current_streak']}-day streak alive today.", 'ar' => "حافظ على سلسلة {$stats['current_streak']} أيام اليوم."],
                default => null,
            };

            return [
                'id' => $habit->id, 'title' => $habit->title, 'color' => $habit->color, 'recent' => $dates->sort()->values(), 'recurrence' => $habit->recurrence, 'consistency' => $current, 'previous_consistency' => $previous,
                'trend' => $current - $previous >= 10 ? 'up' : ($previous - $current >= 10 ? 'down' : 'flat'),
                'current_streak' => $stats['current_streak'], 'longest_streak' => $stats['longest_streak'], 'done_this_period' => $stats['done_this_period'],
                'at_risk' => $stats['current_streak'] >= 3 && ! $stats['done_this_period'], 'best_weekday' => $byWeekday->keys()->first(), 'suggestion' => $suggestion,
            ];
        })->values();
    }
}
