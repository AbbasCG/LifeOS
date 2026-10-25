<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use WeakMap;

/**
 * The personal intelligence layer: one deterministic snapshot of what matters, built from the user's own data by the
 * existing engines (priority scoring, planning windows, conflict detection, goal and habit intelligence, focus history).
 *
 * Every insight states how sure it is (`confidence` with the basis for it) and which data it used (`sources`). Only data
 * sources the user allows are read. Nothing here infers personal characteristics, calls an AI provider or changes data.
 */
class IntelligenceService
{
    public const HORIZON_DAYS = 7;

    /** A deadline moved later this many times is "repeatedly postponed". */
    public const POSTPONED = 2;

    /** In progress but untouched for this many days is "unfinished". */
    public const STALE_DAYS = 3;

    /** @var WeakMap<object, array<int, array<string, mixed>>> snapshots per request, released with the request */
    private WeakMap $cache;

    public function __construct(private PlanningService $planning, private CalendarService $calendar, private ConflictService $conflicts, private GoalIntelligence $goals, private FocusInsights $focus)
    {
        $this->cache = new WeakMap;
    }

    /**
     * @return array<string, mixed>
     */
    public function snapshot(User $user): array
    {
        // Shared by the services used in one request, never across requests (resolved services can outlive a request).
        $request = request();
        $perRequest = $this->cache[$request] ?? [];
        if (! isset($perRequest[$user->id])) {
            $perRequest[$user->id] = $this->build($user);
            $this->cache[$request] = $perRequest;
        }

        return $perRequest[$user->id];
    }

    public function forget(User $user): void
    {
        $request = request();
        if (isset($this->cache[$request])) {
            $perRequest = $this->cache[$request];
            unset($perRequest[$user->id]);
            $this->cache[$request] = $perRequest;
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function build(User $user): array
    {
        $settings = IntelligenceSettings::for($user);
        $allow = fn (string $source) => (bool) ($settings['sources'][$source] ?? false);
        $c = $this->planning->config($user);
        $tz = $c['tz'];
        $now = CarbonImmutable::now($tz);
        $today = $now->startOfDay();
        $horizon = $today->addDays(self::HORIZON_DAYS);

        // Calendar: LifeOS events, plus connected calendars only when that source is allowed.
        $occurrences = $allow('calendar') ? $this->calendar->occurrences($user, $today->utc(), $horizon->utc()) : collect();
        if (! $allow('connected')) {
            $occurrences = $occurrences->filter(fn (array $o) => ($o['source'] ?? 'lifeos') === 'lifeos')->values();
        }
        $calendarSources = $occurrences->pluck('source')->map(fn ($s) => $s ?? 'lifeos')->unique()->values()->all();

        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get();
        $pressure = $allow('goals') ? $this->goals->pressure($user) : [];
        $risks = $allow('calendar') ? collect($this->conflicts->deadlines($user, $occurrences, $now->utc(), $horizon->utc()))->keyBy(fn ($r) => (int) substr($r['items'][0], 5)) : collect();
        $scheduled = CalendarEvent::where('user_id', $user->id)->whereNotNull('task_id')->where('ends_at', '>', $now->utc())->pluck('task_id')->flip();

        $priorities = BriefingService::rank($open, $now, $pressure)->take(10)->map(function (array $row) use ($now, $risks, $scheduled, $pressure) {
            /** @var Task $task */
            $task = $row['task'];
            $risk = $risks->get($task->id);
            $reasons = $row['reasons'];
            if ($risk) {
                $reasons[] = 'deadline_risk';
            }
            if ($task->postponed_count >= self::POSTPONED) {
                $reasons[] = 'postponed';
            }
            $level = match (true) {
                $task->due_at !== null && $task->due_at->isPast(), $risk !== null => 'high',
                $task->due_at !== null && $now->diffInHours($task->due_at, false) <= 72 => 'medium',
                default => 'low',
            };

            return [
                'id' => $task->id, 'title' => $task->title, 'priority' => $task->priority, 'status' => $task->status, 'due_at' => $task->due_at?->toIso8601String(),
                'estimated_minutes' => $task->estimated_minutes, 'score' => min(100, $row['score']), 'reasons' => array_values(array_unique($reasons)), 'risk' => $level,
                'scheduled' => $scheduled->has($task->id), 'postponed_count' => (int) $task->postponed_count,
                // Priority, deadline and status are facts the user entered; a deadline risk also depends on the estimate.
                'confidence' => $risk ? ($task->estimated_minutes > 0 ? 'medium' : 'low') : 'high',
                'sources' => array_values(array_filter(['tasks', $pressure && $task->goal_id ? 'goals' : null, $risk ? 'calendar' : null])),
            ];
        })->values();

        $summary = $this->planning->summary($user, $today, self::HORIZON_DAYS, [], [], $c, $occurrences);
        $workload = collect($summary['days'])->map(fn (array $d) => [
            'date' => $d['date'], 'work_day' => $d['work_day'], 'capacity_minutes' => $d['capacity_minutes'], 'committed_minutes' => $d['fixed_minutes'] + $d['existing_flexible_minutes'],
            'free_minutes' => $d['free_minutes'], 'load_percent' => $d['load_percent'], 'overloaded' => (bool) $d['overloaded'],
        ])->values();

        $windows = $this->planning->windows($c, $today);
        $busy = $occurrences->filter(fn (array $o) => $o['starts_at'] < $today->addDay()->utc())->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();
        $focusWindows = collect($windows)->flatMap(fn (array $w, string $area) => collect($this->planning->freeIntervals(max($w[0], $now)->utc(), $w[1]->utc(), $busy, $c['break']))
            ->map(fn (array $f) => ['area' => $area, 'starts_at' => $f[0]->toIso8601String(), 'ends_at' => $f[1]->toIso8601String(), 'minutes' => (int) $f[0]->diffInMinutes($f[1])]))
            ->filter(fn (array $s) => $s['minutes'] >= 30)->sortBy('starts_at')->values();

        $conflicts = $allow('calendar') ? collect($this->conflicts->detect($user, $now->utc(), $horizon->utc(), $occurrences))->where('severity', 'high')->whereIn('type', ['overlap', 'busy_task'])->values() : collect();

        $goals = $allow('goals') ? $this->goals->goals($user)->whereIn('status', ['at_risk', 'behind', 'overdue'])->map(fn (array $g) => [
            'id' => $g['id'], 'title' => $g['title'], 'status' => $g['status'], 'percent' => $g['percent'], 'reasons' => $g['reasons'], 'next_action' => $g['next_actions'][0] ?? null,
            'confidence' => 'medium', 'sources' => ['goals', 'tasks'],
        ])->values() : collect();
        $habits = $allow('habits') ? $this->goals->habits($user)->filter(fn (array $h) => $h['at_risk'] || $h['trend'] === 'down')->map(fn (array $h) => [
            'id' => $h['id'], 'title' => $h['title'], 'at_risk' => $h['at_risk'], 'trend' => $h['trend'], 'current_streak' => $h['current_streak'], 'consistency' => $h['consistency'], 'suggestion' => $h['suggestion'],
            'confidence' => 'high', 'sources' => ['habits'],
        ])->values() : collect();

        $unfinished = $open->filter(fn (Task $t) => $t->status === 'in_progress' && $t->updated_at && $t->updated_at->lt($now->subDays(self::STALE_DAYS)))
            ->sortBy('updated_at')->take(5)->map(fn (Task $t) => ['id' => $t->id, 'title' => $t->title, 'idle_days' => (int) $t->updated_at->diffInDays($now), 'due_at' => $t->due_at?->toIso8601String(), 'confidence' => 'high', 'sources' => ['tasks']])->values();
        $postponed = $open->filter(fn (Task $t) => $t->postponed_count >= self::POSTPONED)->sortByDesc('postponed_count')->take(5)
            ->map(fn (Task $t) => ['id' => $t->id, 'title' => $t->title, 'postponed_count' => (int) $t->postponed_count, 'due_at' => $t->due_at?->toIso8601String(), 'confidence' => 'high', 'sources' => ['tasks']])->values();

        return [
            'generated_at' => $now->toIso8601String(), 'timezone' => $tz, 'date' => $today->toDateString(),
            'priorities' => $priorities, 'deadline_risks' => $risks->values(), 'workload' => $workload, 'focus_windows' => $focusWindows,
            'focus_capacity' => $this->capacity($user, $c, $focusWindows, $allow('focus')),
            'conflicts' => $conflicts, 'goals' => $goals, 'habits' => $habits, 'unfinished' => $unfinished, 'postponed' => $postponed,
            'occurrences' => $occurrences, 'calendar_sources' => $calendarSources,
            'sources' => array_keys(array_filter($settings['sources'])),
        ];
    }

    /**
     * How much deep work today can realistically hold: the free time left, capped by what the user typically focuses in
     * a day (their history, or their own daily limit). Confidence reflects how much history there is.
     *
     * @param  array<string, mixed>  $c
     * @param  Collection<int, array<string, mixed>>  $windows
     * @return array<string, mixed>
     */
    public function capacity(User $user, array $c, Collection $windows, bool $useHistory): array
    {
        $free = (int) $windows->sum('minutes');
        $history = $useHistory ? $this->focus->summary($user, 14) : null;
        $sessions = (int) ($history['sessions'] ?? 0);
        $days = (int) ($history['focus_days'] ?? 0);
        $typical = $days > 0 ? (int) round($history['minutes'] / $days) : null;
        $cap = $c['daily_limit'] ?: ($typical !== null && $sessions >= 3 ? (int) round($typical * 1.2) : null);
        $minutes = $cap !== null ? min($free, $cap) : $free;
        $confidence = match (true) {
            $sessions >= 10 && $days >= 5 => 'high', $sessions >= 3 => 'medium', default => 'low',
        };

        return [
            'minutes' => $minutes, 'free_minutes' => $free, 'typical_daily_minutes' => $typical, 'daily_limit' => $c['daily_limit'] ?: null,
            'basis' => ['sessions' => $sessions, 'days' => $days, 'window_days' => 14], 'confidence' => $confidence,
            'sources' => array_values(array_filter(['calendar', $useHistory ? 'focus' : null])),
        ];
    }

    /** Focus minutes completed today (for "missed focus opportunity" checks). */
    public function focusToday(User $user, CarbonImmutable $day): int
    {
        return (int) floor(FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')
            ->whereBetween('completed_at', [$day->utc(), $day->addDay()->utc()])->sum('elapsed_seconds') / 60);
    }
}
