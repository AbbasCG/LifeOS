<?php

namespace App\Services;

use App\Models\FocusSession;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;

class AnalyticsService
{
    private const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    private const WEEKDAYS_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    public function __construct(private HabitStreaks $streaks) {}

    /**
     * Productivity analytics for the last $days days in the user's timezone, compared with the period before it.
     *
     * @return array<string, mixed>
     */
    public function summary(User $user, int $days): array
    {
        $tz = $user->timezone();
        $today = CarbonImmutable::now($tz)->startOfDay();
        $from = $today->subDays($days - 1);
        $to = $today->addDay();
        $previousFrom = $from->subDays($days);

        $completed = Task::where('user_id', $user->id)
            ->where('status', 'completed')
            ->whereBetween('completed_at', [$previousFrom->utc(), $to->utc()])
            ->get(['id', 'project_id', 'priority', 'estimated_minutes', 'actual_minutes', 'due_at', 'completed_at']);
        [$current, $previous] = $completed->partition(fn (Task $task) => $task->completed_at >= $from);
        $created = Task::where('user_id', $user->id)->whereBetween('created_at', [$from->utc(), $to->utc()])->pluck('created_at');
        $sessions = FocusSession::where('user_id', $user->id)
            ->whereIn('kind', ['focus', 'manual'])
            ->where('status', 'completed')
            ->whereBetween('completed_at', [$previousFrom->utc(), $to->utc()])
            ->get(['id', 'task_id', 'elapsed_seconds', 'completed_at']);
        [$currentSessions, $previousSessions] = $sessions->partition(fn (FocusSession $session) => $session->completed_at >= $from);

        $series = [];
        for ($day = $from; $day < $to; $day = $day->addDay()) {
            $series[$day->toDateString()] = ['date' => $day->toDateString(), 'completed' => 0, 'created' => 0, 'focus_minutes' => 0];
        }
        $local = fn ($instant) => CarbonImmutable::parse($instant)->setTimezone($tz);
        foreach ($current as $task) {
            $series[$local($task->completed_at)->toDateString()]['completed']++;
        }
        foreach ($created as $instant) {
            $key = $local($instant)->toDateString();
            if (isset($series[$key])) {
                $series[$key]['created']++;
            }
        }
        $byHour = array_fill(0, 24, 0);
        $byWeekday = array_fill(0, 7, 0);
        foreach ($currentSessions as $session) {
            $minutes = $session->elapsed_seconds / 60;
            $end = $local($session->completed_at);
            $series[$end->toDateString()]['focus_minutes'] += $minutes;
            $byHour[$end->subSeconds($session->elapsed_seconds)->hour] += $minutes;
            $byWeekday[$end->dayOfWeek] += $minutes;
        }
        $series = array_map(fn (array $day) => ['focus_minutes' => (int) round($day['focus_minutes'])] + $day, array_values($series));

        $focusMinutes = (int) floor($currentSessions->sum('elapsed_seconds') / 60);
        $previousFocus = (int) floor($previousSessions->sum('elapsed_seconds') / 60);
        $withDue = $current->filter(fn (Task $task) => $task->due_at !== null);
        $tracked = $current->filter(fn (Task $task) => $task->actual_minutes > 0);
        $estimated = (int) $tracked->sum('estimated_minutes');
        $actual = (int) $tracked->sum('actual_minutes');

        $projectTitles = Project::where('user_id', $user->id)->pluck('title', 'id');
        $projectColors = Project::where('user_id', $user->id)->pluck('color', 'id');
        $sessionProjects = Task::where('user_id', $user->id)->whereIn('id', $currentSessions->pluck('task_id')->filter())->pluck('project_id', 'id');
        $byProject = [];
        foreach ($current as $task) {
            $key = $task->project_id ?? 0;
            $byProject[$key] ??= ['completed' => 0, 'focus_minutes' => 0];
            $byProject[$key]['completed']++;
        }
        foreach ($currentSessions as $session) {
            $key = $session->task_id ? ($sessionProjects[$session->task_id] ?? 0) : 0;
            $byProject[$key] ??= ['completed' => 0, 'focus_minutes' => 0];
            $byProject[$key]['focus_minutes'] += (int) floor($session->elapsed_seconds / 60);
        }
        $byProject = collect($byProject)
            ->map(fn (array $row, int $id) => ['project_id' => $id ?: null, 'title' => $id ? ($projectTitles[$id] ?? null) : null, 'color' => $id ? ($projectColors[$id] ?? null) : null] + $row)
            ->sortByDesc(fn (array $row) => $row['focus_minutes'] + $row['completed'] * 30)
            ->take(8)
            ->values();

        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->selectRaw('priority, count(*) as total')->groupBy('priority')->pluck('total', 'priority');
        $byPriority = collect(['urgent', 'high', 'medium', 'low'])->map(fn (string $priority) => ['priority' => $priority, 'completed' => $current->where('priority', $priority)->count(), 'open' => (int) ($open[$priority] ?? 0)]);

        $totals = [
            'completed' => $current->count(),
            'created' => $created->count(),
            'focus_minutes' => $focusMinutes,
            'sessions' => $currentSessions->count(),
            'average_session_minutes' => $currentSessions->count() ? (int) round($focusMinutes / $currentSessions->count()) : 0,
            'on_time_rate' => $withDue->count() ? (int) round($withDue->filter(fn (Task $task) => $task->completed_at <= $task->due_at)->count() / $withDue->count() * 100) : null,
            'estimated_minutes' => $estimated,
            'actual_minutes' => $actual,
            'estimate_ratio' => $estimated ? round($actual / $estimated, 2) : null,
        ];
        $comparison = [
            'completed' => ['previous' => $previous->count(), 'change' => $this->change($current->count(), $previous->count())],
            'focus_minutes' => ['previous' => $previousFocus, 'change' => $this->change($focusMinutes, $previousFocus)],
        ];

        return [
            'range' => ['days' => $days, 'from' => $from->toDateString(), 'to' => $today->toDateString(), 'timezone' => $tz],
            'totals' => $totals,
            'comparison' => $comparison,
            'series' => $series,
            'by_project' => $byProject,
            'by_priority' => $byPriority,
            'focus_by_hour' => array_map(fn (float|int $minutes, int $hour) => ['hour' => $hour, 'minutes' => (int) round($minutes)], $byHour, array_keys($byHour)),
            'focus_by_weekday' => array_map(fn (float|int $minutes, int $day) => ['weekday' => $day, 'minutes' => (int) round($minutes)], $byWeekday, array_keys($byWeekday)),
            'habits' => $this->habits($user, $from, $today, $days),
            'insights' => $this->insights($totals, $comparison, $byHour, $byWeekday),
        ];
    }

    private function change(int $current, int $previous): ?int
    {
        return $previous > 0 ? (int) round(($current - $previous) / $previous * 100) : null;
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function habits(User $user, CarbonImmutable $from, CarbonImmutable $today, int $days): array
    {
        $habits = Habit::where('user_id', $user->id)->orderBy('created_at')->limit(50)->get();
        $entries = HabitEntry::whereIn('habit_id', $habits->pluck('id'))->where('date', '>=', $today->subDays(400)->toDateString())->get()->groupBy('habit_id');

        return $habits->map(function (Habit $habit) use ($entries, $from, $today, $days) {
            $dates = $entries->get($habit->id, collect())->map(fn (HabitEntry $entry) => substr((string) $entry->date, 0, 10));
            $inRange = $dates->filter(fn (string $date) => $date >= $from->toDateString() && $date <= $today->toDateString())->count();
            $expected = $habit->recurrence === 'weekly' ? (int) ceil($days / 7) : $days;

            return ['id' => $habit->id, 'title' => $habit->title, 'color' => $habit->color, 'completions' => $inRange, 'expected' => $expected, 'consistency' => (int) min(100, round($inRange / max(1, $expected) * 100))] + $this->streaks->calculate($dates, $habit->recurrence, $today);
        })->values()->all();
    }

    /**
     * @param  array<string, mixed>  $totals
     * @param  array<string, array{previous: int, change: int|null}>  $comparison
     * @param  array<int, float|int>  $byHour
     * @param  array<int, float|int>  $byWeekday
     * @return list<array{type: string, en: string, ar: string}>
     */
    private function insights(array $totals, array $comparison, array $byHour, array $byWeekday): array
    {
        $insights = [];
        if ($totals['focus_minutes'] > 0) {
            $hour = array_keys($byHour, max($byHour))[0];
            $label = sprintf('%02d:00', $hour);
            $insights[] = ['type' => 'info', 'en' => "You focus most around {$label}. Protect that time for deep work.", 'ar' => "تركيزك الأعلى حول الساعة {$label}. احمِ هذا الوقت للعمل العميق."];
            $day = array_keys($byWeekday, max($byWeekday))[0];
            $insights[] = ['type' => 'info', 'en' => self::WEEKDAYS_EN[$day].' is your strongest focus day.', 'ar' => 'يوم '.self::WEEKDAYS_AR[$day].' هو أقوى أيام تركيزك.'];
        }
        $change = $comparison['completed']['change'];
        if ($change !== null && $change >= 10) {
            $insights[] = ['type' => 'positive', 'en' => "You completed {$change}% more tasks than the previous period.", 'ar' => "أنجزت مهاماً أكثر بنسبة {$change}٪ مقارنة بالفترة السابقة."];
        } elseif ($change !== null && $change <= -10) {
            $drop = abs($change);
            $insights[] = ['type' => 'warning', 'en' => "Completed tasks dropped {$drop}% from the previous period. Consider a lighter, more focused plan.", 'ar' => "انخفضت المهام المنجزة بنسبة {$drop}٪ عن الفترة السابقة. جرّب خطة أخف وأكثر تركيزاً."];
        }
        $ratio = $totals['estimate_ratio'];
        if ($ratio !== null && $ratio > 1.2) {
            $over = (int) round(($ratio - 1) * 100);
            $insights[] = ['type' => 'warning', 'en' => "Tasks take about {$over}% longer than estimated. Add buffer to your estimates.", 'ar' => "تستغرق المهام وقتاً أطول بنحو {$over}٪ من التقدير. أضف هامشاً لتقديراتك."];
        } elseif ($ratio !== null && $ratio < 0.8) {
            $insights[] = ['type' => 'positive', 'en' => 'You finish tasks faster than you estimate. You may be able to plan more.', 'ar' => 'تنجز المهام أسرع من تقديرك. قد تستطيع التخطيط لأكثر.'];
        }
        if ($totals['on_time_rate'] !== null && $totals['on_time_rate'] < 60) {
            $insights[] = ['type' => 'warning', 'en' => "Only {$totals['on_time_rate']}% of tasks with deadlines were completed on time.", 'ar' => "أُنجزت {$totals['on_time_rate']}٪ فقط من المهام ذات المواعيد في وقتها."];
        }
        if (! $insights) {
            $insights[] = ['type' => 'info', 'en' => 'Complete tasks and focus sessions to unlock personal insights.', 'ar' => 'أنجز المهام وجلسات التركيز لتظهر لك رؤى شخصية.'];
        }

        return $insights;
    }
}
