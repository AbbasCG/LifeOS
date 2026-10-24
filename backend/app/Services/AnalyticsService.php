<?php

namespace App\Services;

use App\Models\Category;
use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

class AnalyticsService
{
    private const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    private const WEEKDAYS_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    /** Minimum days per group before an energy comparison is shown. */
    public const MIN_DAYS_PER_GROUP = 3;

    /** Previous-period amounts below these are too small for a meaningful percentage. */
    public const SMALL_BASE = ['completed' => 3, 'focus_minutes' => 180];

    public function __construct(private HabitStreaks $streaks, private GoalIntelligence $goals) {}

    /**
     * Productivity analytics for the last $days days (or an explicit local date range) in the user's timezone,
     * optionally limited to one project, compared with the equally long period before it.
     *
     * @return array<string, mixed>
     */
    public function summary(User $user, int $days = 30, ?string $fromDate = null, ?string $toDate = null, ?int $projectId = null): array
    {
        $tz = $user->timezone();
        $now = CarbonImmutable::now($tz);
        $today = $now->startOfDay();
        if ($fromDate && $toDate) {
            $from = CarbonImmutable::parse($fromDate, $tz)->startOfDay();
            $last = CarbonImmutable::parse($toDate, $tz)->startOfDay();
            $days = (int) $from->diffInDays($last) + 1;
        } else {
            $last = $today;
            $from = $today->subDays($days - 1);
        }
        $to = $last->addDay();
        $previousFrom = $from->subDays($days);
        $project = $projectId ? Project::where('user_id', $user->id)->find($projectId) : null;
        $projectTaskIds = $project ? Task::where('user_id', $user->id)->where('project_id', $project->id)->pluck('id') : null;

        $completed = Task::where('user_id', $user->id)
            ->where('status', 'completed')
            ->when($project, fn ($q) => $q->where('project_id', $project->id))
            ->whereBetween('completed_at', [$previousFrom->utc(), $to->utc()])
            ->get(['id', 'project_id', 'category_id', 'priority', 'estimated_minutes', 'actual_minutes', 'due_at', 'completed_at']);
        [$current, $previous] = $completed->partition(fn (Task $task) => $task->completed_at >= $from);
        $created = Task::where('user_id', $user->id)->when($project, fn ($q) => $q->where('project_id', $project->id))->whereBetween('created_at', [$from->utc(), $to->utc()])->pluck('created_at');
        $sessions = FocusSession::where('user_id', $user->id)
            ->whereIn('kind', ['focus', 'manual'])
            ->where('status', 'completed')
            ->when($project, fn ($q) => $q->where(fn ($q) => $q->where('project_id', $project->id)->orWhereIn('task_id', $projectTaskIds)))
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

        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->when($project, fn ($q) => $q->where('project_id', $project->id))->selectRaw('priority, count(*) as total')->groupBy('priority')->pluck('total', 'priority');
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
            'completed' => ['previous' => $previous->count(), 'change' => $this->change($current->count(), $previous->count()), 'small_base' => $previous->count() < self::SMALL_BASE['completed']],
            'focus_minutes' => ['previous' => $previousFocus, 'change' => $this->change($focusMinutes, $previousFocus), 'small_base' => $previousFocus < self::SMALL_BASE['focus_minutes']],
        ];
        $energy = $this->energy($user, $series);
        $consistency = $this->consistency($series);
        $workload = $this->workload($user, $current, $currentSessions, $sessionProjects, $project?->id, $tz);
        $goals = $project ? [] : $this->goals->goals($user)->map(fn (array $g) => ['id' => $g['id'], 'title' => $g['title'], 'color' => $g['color'], 'percent' => $g['percent'], 'expected_percent' => $g['expected_percent'], 'status' => $g['status'], 'days_left' => $g['days_left'], 'trend' => $g['trend']['direction']])->values()->all();

        return [
            'range' => ['days' => $days, 'from' => $from->toDateString(), 'to' => $last->toDateString(), 'timezone' => $tz, 'previous_from' => $previousFrom->toDateString(), 'previous_to' => $from->subDay()->toDateString(), 'custom' => (bool) ($fromDate && $toDate)],
            'project' => $project ? ['id' => $project->id, 'title' => $project->title, 'color' => $project->color] : null,
            'totals' => $totals,
            'comparison' => $comparison,
            'series' => $series,
            'by_project' => $byProject,
            'by_priority' => $byPriority,
            'focus_by_hour' => array_map(fn (float|int $minutes, int $hour) => ['hour' => $hour, 'minutes' => (int) round($minutes)], $byHour, array_keys($byHour)),
            'focus_by_weekday' => array_map(fn (float|int $minutes, int $day) => ['weekday' => $day, 'minutes' => (int) round($minutes)], $byWeekday, array_keys($byWeekday)),
            'habits' => $this->habits($user, $from, $today, $days),
            'energy' => $energy,
            'consistency' => $consistency,
            'workload' => $workload,
            'goals' => $goals,
            'periods' => $this->periods($user, $now, $project?->id, $projectTaskIds),
            'insights' => [...$this->insights($totals, $comparison, $byHour, $byWeekday), ...$this->patternInsights($energy, $consistency, $workload)],
        ];
    }

    /**
     * Focus and completions grouped by the day's checked-in energy. Groups with fewer than MIN_DAYS_PER_GROUP days
     * are reported but marked unreliable, and no comparison is drawn from them.
     *
     * @param  list<array{date: string, completed: int, focus_minutes: int}>  $series
     * @return array<string, mixed>
     */
    private function energy(User $user, array $series): array
    {
        $enabled = (bool) ($user->preferences()['checkins_enabled'] ?? true);
        if (! $enabled || $series === []) {
            return ['enabled' => $enabled, 'checked_in_days' => 0, 'groups' => [], 'reliable' => false, 'days' => []];
        }
        $energy = DailyCheckin::where('user_id', $user->id)->whereBetween('date', [$series[0]['date'], end($series)['date']])->whereNotNull('energy')->get(['date', 'energy'])
            ->mapWithKeys(fn (DailyCheckin $c) => [$c->date->toDateString() => $c->energy]);
        $days = collect($series)->filter(fn (array $d) => $energy->has($d['date']))->map(fn (array $d) => ['date' => $d['date'], 'energy' => $energy[$d['date']], 'focus_minutes' => $d['focus_minutes'], 'completed' => $d['completed']])->values();
        $groups = collect(['low' => [1, 2], 'medium' => [3], 'high' => [4, 5]])->map(function (array $levels, string $key) use ($days) {
            $rows = $days->whereIn('energy', $levels);

            return ['level' => $key, 'days' => $rows->count(), 'avg_focus_minutes' => $rows->count() ? (int) round($rows->avg('focus_minutes')) : null, 'avg_completed' => $rows->count() ? round($rows->avg('completed'), 1) : null, 'reliable' => $rows->count() >= self::MIN_DAYS_PER_GROUP];
        })->values();
        $reliable = $groups->where('reliable', true)->count() >= 2;

        return ['enabled' => true, 'checked_in_days' => $days->count(), 'groups' => $groups->all(), 'reliable' => $reliable, 'min_days_per_group' => self::MIN_DAYS_PER_GROUP, 'days' => $days->all()];
    }

    /**
     * How regularly focus happens: share of days with focus, longest run of focus days and focus per week.
     *
     * @param  list<array{date: string, completed: int, focus_minutes: int}>  $series
     * @return array<string, mixed>
     */
    private function consistency(array $series): array
    {
        $run = 0;
        $longest = 0;
        $weeks = [];
        foreach ($series as $index => $day) {
            $run = $day['focus_minutes'] > 0 ? $run + 1 : 0;
            $longest = max($longest, $run);
            $week = intdiv($index, 7);
            $weeks[$week] ??= ['start' => $day['date'], 'focus_minutes' => 0, 'completed' => 0, 'days' => 0];
            $weeks[$week]['focus_minutes'] += $day['focus_minutes'];
            $weeks[$week]['completed'] += $day['completed'];
            $weeks[$week]['days']++;
        }
        $focusDays = count(array_filter($series, fn (array $d) => $d['focus_minutes'] > 0));
        $full = array_values(array_filter($weeks, fn (array $w) => $w['days'] === 7));
        $minutes = array_column($full, 'focus_minutes');
        $mean = $minutes ? array_sum($minutes) / count($minutes) : 0;
        $variation = count($minutes) >= 2 && $mean > 0 ? (int) round(sqrt(array_sum(array_map(fn ($m) => ($m - $mean) ** 2, $minutes)) / count($minutes)) / $mean * 100) : null;

        return ['days' => count($series), 'focus_days' => $focusDays, 'percent' => $series ? (int) round($focusDays / count($series) * 100) : 0, 'longest_streak' => $longest, 'current_streak' => $run, 'weekly_variation' => $variation, 'weeks' => array_values($weeks)];
    }

    /**
     * Where completed work and focus went: by life area (work, study, personal via categories) and by weekday,
     * plus open work due in the next seven days.
     *
     * @param  Collection<int, Task>  $current
     * @param  Collection<int, FocusSession>  $sessions
     * @param  Collection<int, int|null>  $sessionProjects
     * @return array<string, mixed>
     */
    private function workload(User $user, $current, $sessions, $sessionProjects, ?int $projectId, string $tz): array
    {
        $areas = Category::where('user_id', $user->id)->pluck('area', 'id');
        $taskCategories = Task::where('user_id', $user->id)->whereIn('id', $sessions->pluck('task_id')->filter())->pluck('category_id', 'id');
        $byArea = collect(['work', 'study', 'personal'])->mapWithKeys(fn (string $a) => [$a => ['area' => $a, 'completed' => 0, 'focus_minutes' => 0]])->all();
        foreach ($current as $task) {
            $byArea[$areas[$task->category_id] ?? 'work']['completed']++;
        }
        foreach ($sessions as $session) {
            $category = $session->task_id ? ($taskCategories[$session->task_id] ?? null) : null;
            $byArea[$areas[$category] ?? 'work']['focus_minutes'] += (int) floor($session->elapsed_seconds / 60);
        }
        $byWeekday = array_fill(0, 7, 0);
        foreach ($current as $task) {
            $byWeekday[$task->completed_at->setTimezone($tz)->dayOfWeek]++;
        }
        $now = CarbonImmutable::now($tz);
        $dueSoon = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->when($projectId, fn ($q) => $q->where('project_id', $projectId))
            ->where('due_at', '<', $now->addDays(7)->endOfDay()->utc())->get(['estimated_minutes', 'actual_minutes', 'due_at']);
        $total = max(1, array_sum(array_column($byArea, 'focus_minutes')));

        return [
            'by_area' => array_values(array_map(fn (array $a) => $a + ['share' => (int) round($a['focus_minutes'] / $total * 100)], $byArea)),
            'completed_by_weekday' => array_map(fn (int $count, int $day) => ['weekday' => $day, 'completed' => $count], $byWeekday, array_keys($byWeekday)),
            'due_next_7_days' => ['tasks' => $dueSoon->count(), 'overdue' => $dueSoon->filter(fn (Task $t) => $t->due_at->isPast())->count(), 'remaining_minutes' => (int) $dueSoon->sum(fn (Task $t) => max(0, $t->estimated_minutes - (int) $t->actual_minutes))],
        ];
    }

    /**
     * Calendar-aligned comparisons: this week vs last week and this month vs the same span of last month.
     *
     * @param  Collection<int, int>|null  $projectTaskIds
     * @return array<string, array<string, mixed>>
     */
    private function periods(User $user, CarbonImmutable $now, ?int $projectId, $projectTaskIds): array
    {
        // Weeks start on Monday, matching the weekly review.
        $weekStart = $now->startOfWeek(CarbonImmutable::MONDAY)->startOfDay();
        $monthStart = $now->startOfMonth();
        $previousMonthStart = $monthStart->subMonthNoOverflow();
        $measure = function (CarbonImmutable $from, CarbonImmutable $to) use ($user, $projectId, $projectTaskIds): array {
            $completed = Task::where('user_id', $user->id)->where('status', 'completed')->when($projectId, fn ($q) => $q->where('project_id', $projectId))->whereBetween('completed_at', [$from->utc(), $to->utc()])->count();
            $seconds = FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')
                ->when($projectId, fn ($q) => $q->where(fn ($q) => $q->where('project_id', $projectId)->orWhereIn('task_id', $projectTaskIds)))
                ->whereBetween('completed_at', [$from->utc(), $to->utc()])->sum('elapsed_seconds');

            return ['completed' => $completed, 'focus_minutes' => (int) floor($seconds / 60)];
        };
        $compare = function (array $current, array $previous, array $range): array {
            $result = $range + ['current' => $current, 'previous' => $previous];
            foreach (['completed', 'focus_minutes'] as $key) {
                $small = $previous[$key] < self::SMALL_BASE[$key];
                $result['change'][$key] = $small ? null : $this->change($current[$key], $previous[$key]);
                $result['small_base'][$key] = $small;
            }

            return $result;
        };
        $elapsed = $weekStart->diffInSeconds($now);
        $previousMonthEnd = min($previousMonthStart->addSeconds($monthStart->diffInSeconds($now)), $monthStart);

        return [
            'week' => $compare($measure($weekStart, $now), $measure($weekStart->subWeek(), $weekStart->subWeek()->addSeconds($elapsed)), ['from' => $weekStart->toDateString(), 'previous_from' => $weekStart->subWeek()->toDateString()]),
            'month' => $compare($measure($monthStart, $now), $measure($previousMonthStart, $previousMonthEnd), ['from' => $monthStart->toDateString(), 'previous_from' => $previousMonthStart->toDateString()]),
        ];
    }

    /**
     * Suggestions drawn from energy, consistency and workload patterns. Energy findings need reliable groups.
     *
     * @param  array<string, mixed>  $energy
     * @param  array<string, mixed>  $consistency
     * @param  array<string, mixed>  $workload
     * @return list<array{type: string, en: string, ar: string}>
     */
    private function patternInsights(array $energy, array $consistency, array $workload): array
    {
        $insights = [];
        $groups = collect($energy['groups'])->where('reliable', true)->keyBy('level');
        if ($energy['reliable'] && $groups->has('high') && ($low = $groups->get('low') ?? $groups->get('medium'))) {
            $high = $groups['high'];
            if ($high['avg_focus_minutes'] >= $low['avg_focus_minutes'] + 20) {
                $insights[] = ['type' => 'info', 'en' => "On high-energy days ({$high['days']} days) you average {$high['avg_focus_minutes']} focus minutes, versus {$low['avg_focus_minutes']} on lower-energy days ({$low['days']} days). Put demanding work on those days.", 'ar' => "في أيام الطاقة العالية ({$high['days']} أيام) متوسط تركيزك {$high['avg_focus_minutes']} دقيقة، مقابل {$low['avg_focus_minutes']} في الأيام الأقل طاقة ({$low['days']} أيام). ضع العمل الصعب في تلك الأيام."];
            }
        }
        if ($consistency['days'] >= 14 && $consistency['percent'] < 40 && $consistency['focus_days'] > 0) {
            $insights[] = ['type' => 'warning', 'en' => "You focused on {$consistency['focus_days']} of {$consistency['days']} days. A short daily session builds momentum faster than occasional long ones.", 'ar' => "ركزت في {$consistency['focus_days']} من {$consistency['days']} يوماً. جلسة يومية قصيرة تبني الزخم أسرع من جلسات طويلة متفرقة."];
        } elseif ($consistency['longest_streak'] >= 5) {
            $insights[] = ['type' => 'positive', 'en' => "Your longest run of focus days in this period was {$consistency['longest_streak']} days.", 'ar' => "أطول سلسلة أيام تركيز في هذه الفترة: {$consistency['longest_streak']} أيام."];
        }
        $areas = collect($workload['by_area'])->where('focus_minutes', '>', 0);
        $top = $areas->sortByDesc('share')->first();
        if ($areas->count() >= 2 && $top && $top['share'] >= 85 && array_sum(array_column($workload['by_area'], 'focus_minutes')) >= 300) {
            $label = ['work' => ['work', 'العمل'], 'study' => ['study', 'الدراسة'], 'personal' => ['personal', 'الشخصي']][$top['area']];
            $insights[] = ['type' => 'info', 'en' => "{$top['share']}% of your focus went to {$label[0]}. Check that other areas still get the time you intend.", 'ar' => "ذهب {$top['share']}٪ من تركيزك إلى {$label[1]}. تأكد أن المجالات الأخرى تنال الوقت الذي تريده."];
        }

        return $insights;
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
        $previousCompleted = $comparison['completed']['previous'];
        if ($change !== null && $previousCompleted < 3) {
            // A tiny baseline turns into misleading percentages (e.g. "+3200%"); describe the counts instead.
            if ($totals['completed'] > $previousCompleted) {
                $insights[] = ['type' => 'positive', 'en' => "You completed {$totals['completed']} tasks, up from {$previousCompleted} in the previous period.", 'ar' => "أنجزت {$totals['completed']} مهمة مقارنة بـ {$previousCompleted} في الفترة السابقة."];
            }
        } elseif ($change !== null && $change >= 10) {
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
