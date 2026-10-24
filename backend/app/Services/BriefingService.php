<?php

namespace App\Services;

use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

class BriefingService
{
    public const PRIORITY_WEIGHTS = ['urgent' => 40, 'high' => 28, 'medium' => 16, 'low' => 6];

    public function __construct(private HabitStreaks $streaks, private CalendarService $calendar) {}

    /**
     * Rank an open task by urgency and importance. Reasons are stable keys the client translates.
     *
     * @return array{score: int, reasons: list<string>}
     */
    public static function score(Task $task, CarbonImmutable $now): array
    {
        $score = self::PRIORITY_WEIGHTS[$task->priority] ?? 16;
        $reasons = in_array($task->priority, ['urgent', 'high']) ? [$task->priority] : [];
        if ($task->status === 'in_progress') {
            $score += 10;
            $reasons[] = 'in_progress';
        }
        if ($task->due_at) {
            $hours = $now->diffInHours($task->due_at, false);
            if ($hours < 0) {
                $score += 35;
                $reasons[] = 'overdue';
            } elseif ($hours <= 24) {
                $score += 25;
                $reasons[] = 'due_today';
            } elseif ($hours <= 72) {
                $score += 12;
                $reasons[] = 'due_soon';
            }
        }
        if ($task->estimated_minutes <= 30) {
            $score += 3;
            $reasons[] = 'quick_win';
        }

        return ['score' => $score, 'reasons' => $reasons];
    }

    /**
     * Open tasks ordered by score, highest first.
     *
     * @param  Collection<int, Task>  $tasks
     * @return Collection<int, array{task: Task, score: int, reasons: list<string>}>
     */
    public static function rank(Collection $tasks, CarbonImmutable $now): Collection
    {
        return $tasks->map(fn (Task $task) => ['task' => $task] + self::score($task, $now))
            ->sortByDesc('score')
            ->values();
    }

    /**
     * Build the daily briefing shown on the dashboard.
     *
     * @return array<string, mixed>
     */
    public function today(User $user): array
    {
        $prefs = $user->preferences();
        $tz = $prefs['timezone'] ?? 'UTC';
        $now = CarbonImmutable::now($tz);
        $dayStart = $now->startOfDay();
        $dayEnd = $dayStart->addDay();
        $openTasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get();
        $ranked = self::rank($openTasks, $now);
        $events = $this->calendar->occurrences($user, $dayStart->utc(), $dayEnd->utc());
        $completedToday = Task::where('user_id', $user->id)->where('status', 'completed')->whereBetween('completed_at', [$dayStart->utc(), $dayEnd->utc()])->count();
        $focusMinutes = (int) floor(FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')->whereBetween('completed_at', [$dayStart->utc(), $dayEnd->utc()])->sum('elapsed_seconds') / 60);
        $overdue = $openTasks->filter(fn (Task $task) => $task->due_at && $task->due_at->isPast())->count();

        $isWorkDay = in_array($dayStart->dayOfWeek, $prefs['work_days'] ?? [1, 2, 3, 4, 5]);
        $workStart = $dayStart->setTimeFromTimeString($prefs['work_start'] ?? '09:00');
        $workEnd = $dayStart->setTimeFromTimeString($prefs['work_end'] ?? '17:00');
        $availableMinutes = $isWorkDay ? (int) $workStart->diffInMinutes($workEnd) : 0;
        $bookedMinutes = (int) $events->sum(function (array $event) use ($workStart, $workEnd) {
            $start = max($event['starts_at'], $workStart);
            $end = min($event['ends_at'], $workEnd);

            return $end > $start ? $start->diffInMinutes($end) : 0;
        });
        $remainingWork = $isWorkDay && $now < $workEnd ? (int) max($now, $workStart)->diffInMinutes($workEnd) : 0;

        $habits = $this->habits($user, $dayStart);
        $goals = Goal::where('user_id', $user->id)
            ->whereColumn('progress', '<', 'target')
            ->orderByRaw('due_at IS NULL, due_at ASC')
            ->limit(4)
            ->get()
            ->map(fn (Goal $goal) => ['id' => $goal->id, 'title' => $goal->title, 'color' => $goal->color, 'progress' => $goal->progress, 'target' => $goal->target, 'percent' => (int) min(100, round($goal->progress / max(1, $goal->target) * 100)), 'due_at' => $goal->due_at?->toIso8601String()]);

        $stats = [
            'completed_today' => $completedToday,
            'focus_minutes_today' => $focusMinutes,
            'open_tasks' => $openTasks->count(),
            'overdue_tasks' => $overdue,
            'available_minutes' => $availableMinutes,
            'booked_minutes' => $bookedMinutes,
            'load_percent' => $availableMinutes ? (int) round($bookedMinutes / $availableMinutes * 100) : 0,
        ];

        return [
            'date' => $dayStart->toDateString(),
            'timezone' => $tz,
            'period' => $now->hour < 12 ? 'morning' : ($now->hour < 18 ? 'afternoon' : 'evening'),
            'stats' => $stats,
            'focus' => $ranked->take(3)->map(fn (array $row) => [
                'id' => $row['task']->id,
                'title' => $row['task']->title,
                'priority' => $row['task']->priority,
                'status' => $row['task']->status,
                'estimated_minutes' => $row['task']->estimated_minutes,
                'due_at' => $row['task']->due_at?->toIso8601String(),
                'score' => $row['score'],
                'reasons' => $row['reasons'],
            ])->values(),
            'agenda' => $events->map(fn (array $event) => ['id' => $event['id'], 'title' => $event['title'], 'kind' => $event['kind'], 'source' => $event['source'], 'recurring' => $event['recurring'] ?? false, 'task_id' => $event['task_id'] ?? null, 'starts_at' => $event['starts_at']->toIso8601String(), 'ends_at' => $event['ends_at']->toIso8601String()])->values(),
            'next_event' => ($next = $events->first(fn (array $event) => $event['starts_at']->isFuture())) ? ['id' => $next['id'], 'title' => $next['title'], 'starts_at' => $next['starts_at']->toIso8601String()] : null,
            'habits' => $habits,
            'goals' => $goals,
            'suggestions' => $this->suggestions($stats, $ranked, $habits, $remainingWork, $isWorkDay),
        ];
    }

    /**
     * @return Collection<int, array<string, mixed>>
     */
    private function habits(User $user, CarbonImmutable $today): Collection
    {
        $habits = Habit::where('user_id', $user->id)->orderBy('created_at')->limit(50)->get();
        $entries = HabitEntry::whereIn('habit_id', $habits->pluck('id'))
            ->where('date', '>=', $today->subDays(400)->toDateString())
            ->get()
            ->groupBy('habit_id');

        return $habits->map(function (Habit $habit) use ($entries, $today) {
            $dates = $entries->get($habit->id, collect())->map(fn (HabitEntry $entry) => substr((string) $entry->date, 0, 10));
            $stats = $this->streaks->calculate($dates, $habit->recurrence, $today);

            return ['id' => $habit->id, 'title' => $habit->title, 'color' => $habit->color, 'recurrence' => $habit->recurrence, 'routine' => $habit->routine] + $stats + ['at_risk' => ! $stats['done_this_period'] && $stats['current_streak'] > 0];
        })->values();
    }

    /**
     * Rule-based, explainable suggestions in both supported languages.
     *
     * @param  array<string, int>  $stats
     * @param  Collection<int, array{task: Task, score: int, reasons: list<string>}>  $ranked
     * @param  Collection<int, array<string, mixed>>  $habits
     * @return list<array{type: string, en: string, ar: string, action: string|null}>
     */
    private function suggestions(array $stats, Collection $ranked, Collection $habits, int $remainingWork, bool $isWorkDay): array
    {
        $suggestions = [];
        if ($stats['overdue_tasks'] > 0) {
            $suggestions[] = ['type' => 'warning', 'en' => "You have {$stats['overdue_tasks']} overdue task(s). Reschedule them or let them go.", 'ar' => "لديك {$stats['overdue_tasks']} مهمة متأخرة. أعد جدولتها أو تخلَّ عنها.", 'action' => '/tasks?due=overdue'];
        }
        if ($stats['load_percent'] > 100) {
            $suggestions[] = ['type' => 'warning', 'en' => "Today is overbooked ({$stats['load_percent']}% of working hours). Consider moving a flexible block.", 'ar' => "يومك مزدحم ({$stats['load_percent']}٪ من ساعات العمل). فكّر في نقل فترة مرنة.", 'action' => '/calendar'];
        } elseif ($isWorkDay && $remainingWork >= 60 && $ranked->isNotEmpty() && $stats['load_percent'] < 60) {
            $hours = round($remainingWork / 60, 1);
            $suggestions[] = ['type' => 'info', 'en' => "About {$hours}h of working time remains today. Generate a plan to use it well.", 'ar' => "تبقّى نحو {$hours} ساعة من وقت العمل اليوم. أنشئ خطة للاستفادة منها.", 'action' => '/planning'];
        }
        if ($stats['focus_minutes_today'] === 0 && ($top = $ranked->first())) {
            $title = mb_substr($top['task']->title, 0, 80);
            $suggestions[] = ['type' => 'info', 'en' => "Start a 25-minute focus session on “{$title}”.", 'ar' => "ابدأ جلسة تركيز لمدة ٢٥ دقيقة على «{$title}».", 'action' => '/focus?task='.$top['task']->id];
        }
        foreach ($habits->where('at_risk', true)->take(2) as $habit) {
            $title = mb_substr($habit['title'], 0, 80);
            $suggestions[] = ['type' => 'info', 'en' => "Keep your “{$title}” streak of {$habit['current_streak']} alive.", 'ar' => "حافظ على سلسلة «{$title}» ({$habit['current_streak']}) مستمرة.", 'action' => '/habits'];
        }
        if ($stats['completed_today'] >= 3) {
            $suggestions[] = ['type' => 'positive', 'en' => "{$stats['completed_today']} tasks done today. Great momentum.", 'ar' => "أنجزت {$stats['completed_today']} مهام اليوم. زخم رائع.", 'action' => null];
        }
        if ($ranked->isEmpty()) {
            $suggestions[] = ['type' => 'positive', 'en' => 'Your list is clear. Capture what’s next when you’re ready.', 'ar' => 'قائمتك فارغة. سجّل ما هو تالٍ عندما تكون مستعداً.', 'action' => null];
        }

        return $suggestions;
    }
}
