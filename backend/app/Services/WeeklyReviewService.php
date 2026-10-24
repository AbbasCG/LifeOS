<?php

namespace App\Services;

use App\Jobs\FireAutomations;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Task;
use App\Models\User;
use App\Models\WeeklyReview;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

class WeeklyReviewService
{
    public function __construct(private PlanningService $planner, private HabitStreaks $streaks) {}

    /**
     * Monday of the week containing $date (user timezone).
     */
    public function weekStart(User $user, string $date): CarbonImmutable
    {
        return CarbonImmutable::parse($date, $user->timezone())->startOfWeek(CarbonImmutable::MONDAY)->startOfDay();
    }

    /**
     * Everything the review screen needs, plus the user's saved reflection and decisions.
     *
     * @return array<string, mixed>
     */
    public function build(User $user, CarbonImmutable $start): array
    {
        $tz = $user->timezone();
        $end = $start->addDays(7);
        $previous = $start->subDays(7);

        $completed = Task::where('user_id', $user->id)->where('status', 'completed')->whereBetween('completed_at', [$start->utc(), $end->utc()])->orderBy('completed_at')->limit(100)->get();
        $plannedVsActual = $this->planner->plannedVsActual($user, $start, 7);
        $plannedTaskIds = collect($plannedVsActual['tasks'])->pluck('task_id');
        $unfinished = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])
            ->where(fn ($q) => $q->where('due_at', '<', $end->utc())->orWhereIn('id', $plannedTaskIds)->orWhere('status', 'in_progress'))
            ->orderByRaw('due_at IS NULL, due_at ASC')->limit(50)->get();

        $sessions = FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')->whereBetween('completed_at', [$previous->utc(), $end->utc()])->get();
        [$thisWeek, $lastWeek] = $sessions->partition(fn (FocusSession $s) => $s->completed_at >= $start);
        $focusMinutes = (int) floor($thisWeek->sum('elapsed_seconds') / 60);
        $previousFocus = (int) floor($lastWeek->sum('elapsed_seconds') / 60);
        $focusByDay = [];
        for ($d = 0; $d < 7; $d++) {
            $focusByDay[$start->addDays($d)->toDateString()] = 0;
        }
        foreach ($thisWeek as $session) {
            $key = $session->completed_at->setTimezone($tz)->toDateString();
            if (isset($focusByDay[$key])) {
                $focusByDay[$key] += (int) floor($session->elapsed_seconds / 60);
            }
        }

        $goals = Goal::where('user_id', $user->id)->orderByRaw('due_at IS NULL, due_at ASC')->limit(10)->get()
            ->map(fn (Goal $g) => ['id' => $g->id, 'title' => $g->title, 'color' => $g->color, 'progress' => $g->progress, 'target' => $g->target, 'percent' => (int) min(100, round($g->progress / max(1, $g->target) * 100)), 'due_at' => $g->due_at?->toIso8601String()]);

        $habitModels = Habit::where('user_id', $user->id)->orderBy('created_at')->limit(50)->get();
        $entries = HabitEntry::whereIn('habit_id', $habitModels->pluck('id'))->where('date', '>=', $start->subDays(400)->toDateString())->get()->groupBy('habit_id');
        $lastDay = $end->subDay();
        $habits = $habitModels->map(function (Habit $habit) use ($entries, $start, $lastDay) {
            $dates = $entries->get($habit->id, collect())->map(fn (HabitEntry $e) => substr((string) $e->date, 0, 10));
            $done = $dates->filter(fn (string $d) => $d >= $start->toDateString() && $d <= $lastDay->toDateString())->count();
            $expected = $habit->recurrence === 'weekly' ? 1 : 7;

            return ['id' => $habit->id, 'title' => $habit->title, 'color' => $habit->color, 'recurrence' => $habit->recurrence, 'completions' => $done, 'expected' => $expected, 'consistency' => (int) min(100, round($done / $expected * 100))] + $this->streaks->calculate($dates, $habit->recurrence, $lastDay);
        })->values();

        $withDue = $completed->filter(fn (Task $t) => $t->due_at !== null);
        $onTime = $withDue->count() ? (int) round($withDue->filter(fn (Task $t) => $t->completed_at <= $t->due_at)->count() / $withDue->count() * 100) : null;
        $overrun = $completed->filter(fn (Task $t) => $t->actual_minutes > 0 && $t->actual_minutes > $t->estimated_minutes * 1.3)->count();
        $metrics = [
            'completed' => $completed->count(),
            'unfinished' => $unfinished->count(),
            'focus_minutes' => $focusMinutes,
            'previous_focus_minutes' => $previousFocus,
            'focus_change' => $previousFocus ? (int) round(($focusMinutes - $previousFocus) / $previousFocus * 100) : null,
            'on_time_rate' => $onTime,
            'habit_consistency' => $habits->count() ? (int) round($habits->avg('consistency')) : null,
            'estimate_overruns' => $overrun,
        ];

        $review = WeeklyReview::where('user_id', $user->id)->whereDate('week_start', $start->toDateString())->first();
        $ranked = BriefingService::rank(Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get(), $end->utc())->take(7);

        return [
            'week_start' => $start->toDateString(),
            'week_end' => $lastDay->toDateString(),
            'timezone' => $tz,
            'metrics' => $metrics,
            'completed' => $completed->map(fn (Task $t) => ['id' => $t->id, 'title' => $t->title, 'priority' => $t->priority, 'completed_at' => $t->completed_at?->toIso8601String(), 'estimated_minutes' => $t->estimated_minutes, 'actual_minutes' => $t->actual_minutes])->values(),
            'unfinished' => $unfinished->map(fn (Task $t) => ['id' => $t->id, 'title' => $t->title, 'priority' => $t->priority, 'status' => $t->status, 'due_at' => $t->due_at?->toIso8601String(), 'overdue' => $t->due_at !== null && $t->due_at->isPast(), 'estimated_minutes' => $t->estimated_minutes])->values(),
            'focus_by_day' => collect($focusByDay)->map(fn (int $minutes, string $date) => ['date' => $date, 'minutes' => $minutes])->values(),
            'planned_vs_actual' => $plannedVsActual,
            'goals' => $goals,
            'goal_health' => app(GoalIntelligence::class)->goals($user)->whereNotIn('status', ['completed'])->map(fn (array $g) => ['id' => $g['id'], 'title' => $g['title'], 'status' => $g['status'], 'percent' => $g['percent'], 'reasons' => $g['reasons'], 'next_action' => $g['next_actions'][0] ?? null])->values(),
            'habits' => $habits,
            'achievements' => $this->achievements($metrics, $habits->all(), $plannedVsActual['totals']),
            'improvements' => $this->improvements($metrics, $habits->all(), $plannedVsActual['totals'], $unfinished->filter(fn (Task $t) => $t->due_at?->isPast())->count()),
            'suggested_priorities' => $ranked->map(fn (array $row) => ['id' => $row['task']->id, 'title' => $row['task']->title, 'priority' => $row['task']->priority, 'estimated_minutes' => $row['task']->estimated_minutes, 'due_at' => $row['task']->due_at?->toIso8601String(), 'reasons' => $row['reasons']])->values(),
            'review' => [
                'status' => $review?->status ?? 'new',
                'reflection' => $review?->reflection ?? ['wins' => '', 'challenges' => '', 'lessons' => '', 'rating' => null],
                'decisions' => (object) ($review?->decisions ?? []),
                'priorities' => $review?->priorities ?? [],
                'completed_at' => $review?->completed_at?->toIso8601String(),
            ],
        ];
    }

    /**
     * @param  array<string, mixed>  $data
     */
    public function save(User $user, CarbonImmutable $start, array $data): WeeklyReview
    {
        $review = WeeklyReview::firstOrNew(['user_id' => $user->id, 'week_start' => $start->toDateString()]);
        $review->fill([
            'reflection' => $data['reflection'] ?? $review->reflection ?? [],
            'decisions' => $data['decisions'] ?? $review->decisions ?? [],
            'priorities' => $data['priorities'] ?? $review->priorities ?? [],
        ]);
        $review->status ??= 'draft';
        $review->save();

        return $review;
    }

    /**
     * Save the review and apply the user's confirmed decisions to unfinished tasks.
     *
     * @param  array<string, mixed>  $data
     * @return array{applied: array<string, int>}
     */
    public function complete(User $user, CarbonImmutable $start, array $data): array
    {
        return DB::transaction(function () use ($user, $start, $data) {
            $review = $this->save($user, $start, $data);
            $applied = ['done' => 0, 'drop' => 0, 'carry' => 0];
            $decisions = $review->decisions ?? [];
            $tasks = Task::where('user_id', $user->id)->whereIn('id', array_keys($decisions))->whereNotIn('status', ['completed', 'cancelled'])->lockForUpdate()->get();
            foreach ($tasks as $task) {
                $action = $decisions[$task->id] ?? $decisions[(string) $task->id] ?? null;
                if ($action === 'done') {
                    $task->update(['status' => 'completed', 'completed_at' => now()]);
                    $task->createNextOccurrence();
                } elseif ($action === 'drop') {
                    $task->update(['status' => 'cancelled', 'completed_at' => null]);
                } elseif ($action === 'carry' && $task->status === 'inbox') {
                    $task->update(['status' => 'todo']);
                }
                if (isset($applied[$action])) {
                    $applied[$action]++;
                }
            }
            $snapshot = $this->build($user, $start)['metrics'];
            $review->update(['status' => 'completed', 'completed_at' => now(), 'snapshot' => $snapshot + ['applied' => $applied]]);
            FireAutomations::dispatch($user->id, 'weekly_review_completed', $review->id)->afterCommit();

            return ['applied' => $applied];
        });
    }

    /**
     * @param  array<string, mixed>  $metrics
     * @param  list<array<string, mixed>>  $habits
     * @param  array<string, mixed>  $planned
     * @return list<array{key: string, en: string, ar: string}>
     */
    private function achievements(array $metrics, array $habits, array $planned): array
    {
        $list = [];
        if ($metrics['completed'] >= 10) {
            $list[] = ['key' => 'ten_tasks', 'en' => "{$metrics['completed']} tasks completed — a productive week.", 'ar' => "أنجزت {$metrics['completed']} مهمة — أسبوع منتج."];
        } elseif ($metrics['completed'] >= 3) {
            $list[] = ['key' => 'steady', 'en' => "{$metrics['completed']} tasks completed. Steady progress.", 'ar' => "أنجزت {$metrics['completed']} مهام. تقدم ثابت."];
        }
        if ($metrics['focus_minutes'] >= 300) {
            $hours = round($metrics['focus_minutes'] / 60, 1);
            $list[] = ['key' => 'deep_work', 'en' => "{$hours} hours of focused work.", 'ar' => "{$hours} ساعة من العمل المركز."];
        }
        if ($metrics['focus_change'] !== null && $metrics['focus_change'] >= 20) {
            $list[] = ['key' => 'focus_up', 'en' => "Focus time up {$metrics['focus_change']}% on last week.", 'ar' => "ارتفع وقت التركيز {$metrics['focus_change']}٪ عن الأسبوع الماضي."];
        }
        foreach ($habits as $habit) {
            if ($habit['consistency'] === 100) {
                $list[] = ['key' => 'perfect_habit_'.$habit['id'], 'en' => "Perfect week for “{$habit['title']}”.", 'ar' => "أسبوع كامل لعادة «{$habit['title']}»."];
            } elseif ($habit['current_streak'] >= 7 && $habit['recurrence'] === 'daily') {
                $list[] = ['key' => 'streak_'.$habit['id'], 'en' => "“{$habit['title']}” streak reached {$habit['current_streak']}.", 'ar' => "وصلت سلسلة «{$habit['title']}» إلى {$habit['current_streak']}."];
            }
        }
        if ($metrics['on_time_rate'] === 100) {
            $list[] = ['key' => 'on_time', 'en' => 'Every task with a deadline was finished on time.', 'ar' => 'أُنجزت كل المهام ذات المواعيد في وقتها.'];
        }
        if (($planned['completion_rate'] ?? null) !== null && $planned['completion_rate'] >= 80) {
            $list[] = ['key' => 'plan_kept', 'en' => "You completed {$planned['completion_rate']}% of planned tasks.", 'ar' => "أنجزت {$planned['completion_rate']}٪ من المهام المخطط لها."];
        }
        if (! $list && ($metrics['completed'] > 0 || $metrics['focus_minutes'] > 0)) {
            $list[] = ['key' => 'showed_up', 'en' => 'You showed up and made progress. That counts.', 'ar' => 'حضرت وأحرزت تقدماً. وهذا مهم.'];
        }

        return $list;
    }

    /**
     * @param  array<string, mixed>  $metrics
     * @param  list<array<string, mixed>>  $habits
     * @param  array<string, mixed>  $planned
     * @return list<array{key: string, en: string, ar: string}>
     */
    private function improvements(array $metrics, array $habits, array $planned, int $overdue): array
    {
        $list = [];
        if ($overdue > 0) {
            $list[] = ['key' => 'overdue', 'en' => 'Some tasks slipped past their deadline. Decide below whether to finish, carry over or drop them.', 'ar' => 'تجاوزت بعض المهام موعدها. قرّر أدناه إنهاءها أو ترحيلها أو إلغاءها.'];
        }
        if (($planned['ratio'] ?? null) !== null && $planned['ratio'] < 0.6) {
            $percent = (int) round($planned['ratio'] * 100);
            $list[] = ['key' => 'over_planned', 'en' => "You logged {$percent}% of planned focus time. Plan fewer, shorter blocks next week.", 'ar' => "سجّلت {$percent}٪ من وقت التركيز المخطط. خطّط لفترات أقل وأقصر الأسبوع القادم."];
        }
        if ($metrics['focus_minutes'] === 0) {
            $list[] = ['key' => 'no_focus', 'en' => 'No focus sessions were recorded. Try one 25-minute session a day.', 'ar' => 'لم تُسجَّل جلسات تركيز. جرّب جلسة واحدة لمدة ٢٥ دقيقة يومياً.'];
        }
        if ($metrics['estimate_overruns'] > 0) {
            $list[] = ['key' => 'estimates', 'en' => "{$metrics['estimate_overruns']} task(s) took over 30% longer than estimated. Add buffer.", 'ar' => "استغرقت {$metrics['estimate_overruns']} مهمة وقتاً أطول من التقدير بأكثر من ٣٠٪. أضف هامشاً."];
        }
        foreach ($habits as $habit) {
            if ($habit['consistency'] < 50) {
                $list[] = ['key' => 'habit_'.$habit['id'], 'en' => "“{$habit['title']}” happened {$habit['completions']} of {$habit['expected']} times. Make it smaller or tie it to an existing routine.", 'ar' => "تمت عادة «{$habit['title']}» {$habit['completions']} من {$habit['expected']} مرات. صغّرها أو اربطها بروتين قائم."];
            }
        }
        if ($metrics['on_time_rate'] !== null && $metrics['on_time_rate'] < 60) {
            $list[] = ['key' => 'deadlines', 'en' => "Only {$metrics['on_time_rate']}% of deadlines were met. Schedule deadline work earlier.", 'ar' => "تحقق {$metrics['on_time_rate']}٪ فقط من المواعيد. جدول العمل المرتبط بالمواعيد مبكراً."];
        }

        return $list;
    }
}
