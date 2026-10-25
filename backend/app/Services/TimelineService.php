<?php

namespace App\Services;

use App\Integrations\Calendar\CalendarProviders;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\ExternalTask;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * The unified personal timeline: LifeOS events and tasks, connected calendars and task apps, focus sessions, goal
 * deadlines and scheduled habits in one stream. Every item carries its source and whether it is read-only; connected
 * records stay read-only until copied into LifeOS, and the same underlying event or task is never listed twice.
 */
class TimelineService
{
    public const KINDS = ['event', 'task', 'external_task', 'focus', 'goal', 'habit'];

    public const AREAS = ['work', 'study', 'personal'];

    public const MAX_DAYS = 31;

    /** Habit routines placed at a typical local time; anything else is an all-day item. */
    private const ROUTINE_TIMES = ['morning' => '07:30', 'صباح' => '07:30', 'afternoon' => '13:00', 'noon' => '12:30', 'ظهر' => '13:00', 'evening' => '20:00', 'night' => '21:30', 'مساء' => '20:00', 'ليل' => '21:30'];

    public function __construct(private CalendarService $calendar, private ConflictService $conflicts, private CalendarProviders $providers) {}

    /**
     * @param  array{sources?: list<string>, accounts?: list<int>, areas?: list<string>, kinds?: list<string>}  $filters
     * @return array<string, mixed>
     */
    /**
     * What moving one LifeOS event (or one occurrence) to [start, end) would collide with, before anything is saved.
     *
     * @return array{conflicts: list<array<string, mixed>>, fixed: bool, recurring: bool}
     */
    public function preview(User $user, CalendarEvent $event, ?CarbonImmutable $occurrence, CarbonImmutable $start, CarbonImmutable $end): array
    {
        $labels = collect($this->providers->all())->map(fn ($p) => $p->label());
        $conflicts = $this->calendar->conflicts($user, $start, $end, $event->id, $event->isRecurring() ? $occurrence : null)
            // A series move only changes this occurrence, so other occurrences of the same series still count.
            ->map(fn (array $o) => ['title' => $o['title'], 'source' => $o['source'] ?? 'lifeos', 'source_label' => ($o['source'] ?? 'lifeos') === 'lifeos' ? 'LifeOS' : ($labels[$o['source']] ?? $o['source']),
                'starts_at' => $o['starts_at']->toIso8601String(), 'ends_at' => $o['ends_at']->toIso8601String(), 'read_only' => ! ($o['editable'] ?? false),
                'minutes' => (int) max($start, $o['starts_at'])->diffInMinutes(min($end, $o['ends_at']))])
            ->values()->all();

        return ['conflicts' => $conflicts, 'fixed' => $event->kind === 'fixed', 'recurring' => $event->isRecurring()];
    }

    public function build(User $user, CarbonImmutable $fromDay, CarbonImmutable $toDay, array $filters = []): array
    {
        $tz = $user->timezone();
        $from = $fromDay->setTimezone($tz)->startOfDay();
        $to = $toDay->setTimezone($tz)->startOfDay()->addDay();
        $areas = Category::where('user_id', $user->id)->pluck('area', 'id');
        $taskAreas = fn (?int $categoryId) => $categoryId ? ($areas[$categoryId] ?? 'work') : null;
        $accounts = CalendarAccount::where('user_id', $user->id)->get(['id', 'provider', 'email', 'display_name', 'status'])->keyBy('id');
        $labels = collect($this->providers->all())->map(fn ($p) => $p->label());
        $items = collect();

        // Calendar events: LifeOS (incl. recurring) and connected calendars, already de-duplicated by stable identifiers.
        $occurrences = $this->calendar->occurrences($user, $from->utc(), $to->utc());
        $eventTasks = Task::where('user_id', $user->id)->whereIn('id', $occurrences->pluck('task_id')->filter()->unique())->get(['id', 'category_id'])->keyBy('id');
        foreach ($occurrences as $o) {
            $source = $o['source'] ?? 'lifeos';
            $items->push([
                'id' => 'ev:'.$o['id'], 'kind' => 'event', 'source' => $source, 'source_label' => $source === 'lifeos' ? 'LifeOS' : ($labels[$source] ?? $source),
                'account_id' => $o['account_id'] ?? null, 'account' => $o['account_label'] ?? null,
                'title' => $o['title'], 'starts_at' => $o['starts_at']->toIso8601String(), 'ends_at' => $o['ends_at']->toIso8601String(), 'all_day' => (bool) ($o['all_day'] ?? false),
                'area' => isset($o['task_id']) && $o['task_id'] ? $taskAreas($eventTasks[$o['task_id']]->category_id ?? null) : null,
                'read_only' => ! ($o['editable'] ?? false), 'status' => $o['kind'] ?? 'fixed', 'recurring' => (bool) ($o['recurring'] ?? false),
                'moved_from' => $o['moved_from'] ?? null, 'link' => '/calendar', 'meta' => array_filter(['task_id' => $o['task_id'] ?? null, 'timezone' => $source !== 'lifeos' ? ($o['timezone'] ?? null) : null,
                    'event_id' => $source === 'lifeos' ? ($o['event_id'] ?? null) : null, 'occurrence_start' => isset($o['occurrence_start']) ? $o['occurrence_start']->toIso8601String() : null]),
            ]);
        }

        // LifeOS tasks: due in range (open or completed in range).
        Task::where('user_id', $user->id)->where('status', '!=', 'cancelled')->whereBetween('due_at', [$from->utc(), $to->utc()])->limit(300)->get()
            ->each(function (Task $t) use ($items, $taskAreas) {
                $items->push([
                    'id' => 'task:'.$t->id, 'kind' => 'task', 'source' => $t->source_ref ? explode(':', $t->source_ref)[0] : 'lifeos', 'source_label' => 'LifeOS', 'account_id' => null, 'account' => null,
                    'title' => $t->title, 'starts_at' => $t->due_at->toIso8601String(), 'ends_at' => null, 'all_day' => false, 'area' => $taskAreas($t->category_id),
                    'read_only' => false, 'status' => $t->status, 'recurring' => (bool) $t->recurrence, 'moved_from' => null, 'link' => '/tasks',
                    'meta' => array_filter(['priority' => $t->priority, 'estimated_minutes' => $t->estimated_minutes, 'copied' => $t->source_ref !== null ? true : null]),
                ]);
            });

        // Connected tasks (read-only); ones already copied into LifeOS appear only as the LifeOS task.
        $copied = Task::where('user_id', $user->id)->whereNotNull('source_ref')->pluck('source_ref')->flip();
        ExternalTask::where('user_id', $user->id)->whereIn('calendar_account_id', $accounts->where('status', '!=', 'revoked')->keys())
            ->whereBetween('due_at', [$from->utc(), $to->utc()])->limit(300)->get()
            ->reject(fn (ExternalTask $t) => $copied->has($t->sourceRef($accounts[$t->calendar_account_id]->provider)))
            ->each(function (ExternalTask $t) use ($items, $accounts, $labels) {
                $provider = $accounts[$t->calendar_account_id]->provider;
                $items->push([
                    'id' => 'xt:'.$t->id, 'kind' => 'external_task', 'source' => $provider, 'source_label' => $labels[$provider] ?? $provider,
                    'account_id' => $t->calendar_account_id, 'account' => $accounts[$t->calendar_account_id]->email,
                    'title' => $t->title, 'starts_at' => $t->due_at->toIso8601String(), 'ends_at' => null, 'all_day' => $t->due_is_date, 'area' => null,
                    'read_only' => true, 'status' => $t->status, 'recurring' => false, 'moved_from' => null, 'link' => $t->url ?? '/tasks',
                    'meta' => array_filter(['priority' => $t->priority, 'list' => $t->list_name, 'external_id' => $t->id]),
                ]);
            });

        // Focus sessions (completed, plus the running one).
        $sessionTasks = collect();
        FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->whereIn('status', ['completed', 'running', 'paused'])
            ->where(fn ($q) => $q->whereBetween('completed_at', [$from->utc(), $to->utc()])->orWhere(fn ($q) => $q->whereNull('completed_at')->whereBetween('created_at', [$from->utc(), $to->utc()])))
            ->with('task:id,title,category_id')->limit(300)->get()
            ->each(function (FocusSession $s) use ($items, $taskAreas) {
                $end = $s->completed_at ? CarbonImmutable::instance($s->completed_at) : CarbonImmutable::now();
                $start = $s->started_at ? CarbonImmutable::instance($s->started_at) : $end->subSeconds((int) $s->elapsed_seconds);
                $items->push([
                    'id' => 'focus:'.$s->id, 'kind' => 'focus', 'source' => 'lifeos', 'source_label' => 'LifeOS', 'account_id' => null, 'account' => null,
                    'title' => $s->task?->title ?? 'Focus', 'starts_at' => $start->toIso8601String(), 'ends_at' => $end->toIso8601String(), 'all_day' => false,
                    'area' => $taskAreas($s->task?->category_id), 'read_only' => true, 'status' => $s->status, 'recurring' => false, 'moved_from' => null, 'link' => '/focus',
                    'meta' => array_filter(['minutes' => (int) floor($s->elapsed_seconds / 60), 'mode' => $s->mode]),
                ]);
            });

        // Goal deadlines.
        Goal::where('user_id', $user->id)->whereBetween('due_at', [$from->utc(), $to->utc()])->get()->each(function (Goal $g) use ($items) {
            $items->push(['id' => 'goal:'.$g->id, 'kind' => 'goal', 'source' => 'lifeos', 'source_label' => 'LifeOS', 'account_id' => null, 'account' => null, 'title' => $g->title,
                'starts_at' => $g->due_at->toIso8601String(), 'ends_at' => null, 'all_day' => true, 'area' => null, 'read_only' => false,
                'status' => $g->progress >= $g->target ? 'completed' : 'open', 'recurring' => false, 'moved_from' => null, 'link' => '/goals',
                'meta' => ['percent' => (int) min(100, round($g->progress / max(1, $g->target) * 100))]]);
        });

        // Scheduled habits: daily habits each day (at their routine time when known), weekly habits once per week.
        $habits = Habit::where('user_id', $user->id)->limit(50)->get();
        $entries = HabitEntry::whereIn('habit_id', $habits->pluck('id'))->whereBetween('date', [$from->subDays(7)->toDateString(), $to->toDateString()])->get()
            ->groupBy('habit_id')->map(fn ($g) => $g->map(fn ($e) => substr((string) $e->getRawOriginal('date'), 0, 10))->flip());
        foreach ($habits as $habit) {
            $time = collect(self::ROUTINE_TIMES)->first(fn ($t, $word) => $habit->routine && str_contains(mb_strtolower($habit->routine), $word));
            for ($day = $from; $day < $to; $day = $day->addDay()) {
                $weekly = $habit->recurrence === 'weekly';
                if ($weekly && $day->dayOfWeek !== CarbonImmutable::MONDAY && $day->ne($from)) {
                    continue;
                }
                $done = $weekly
                    ? collect($entries[$habit->id] ?? [])->keys()->contains(fn ($d) => CarbonImmutable::parse($d, $day->timezone)->startOfWeek()->eq($day->startOfWeek()))
                    : isset(($entries[$habit->id] ?? collect())[$day->toDateString()]);
                $at = $time ? $day->setTimeFromTimeString($time) : $day;
                $items->push(['id' => 'habit:'.$habit->id.':'.$day->toDateString(), 'kind' => 'habit', 'source' => 'lifeos', 'source_label' => 'LifeOS', 'account_id' => null, 'account' => null,
                    'title' => $habit->title, 'starts_at' => $at->utc()->toIso8601String(), 'ends_at' => null, 'all_day' => ! $time || $weekly, 'area' => 'personal',
                    'read_only' => false, 'status' => $done ? 'completed' : 'open', 'recurring' => true, 'moved_from' => null, 'link' => '/habits',
                    'meta' => ['recurrence' => $habit->recurrence, 'routine' => $habit->routine]]);
            }
        }

        $conflicts = $this->conflicts->detect($user, $from->utc(), $to->utc(), $occurrences);
        $flagged = collect($conflicts)->where('severity', 'high')->flatMap(fn ($c) => $c['items'])->flip();
        $items = $items->map(fn (array $i) => $i + ['conflict' => isset($flagged[$i['id']])]);

        $available = $this->facets($items, $accounts, $labels);
        $items = $this->filter($items, $filters)->sortBy([fn ($a, $b) => $b['all_day'] <=> $a['all_day'], fn ($a, $b) => strtotime($a['starts_at']) <=> strtotime($b['starts_at']), fn ($a, $b) => strcmp($a['kind'], $b['kind'])])->values();

        return [
            'range' => ['from' => $from->toDateString(), 'to' => $to->subDay()->toDateString(), 'timezone' => $tz, 'day_start' => $from->toIso8601String()],
            'items' => $items,
            'conflicts' => $conflicts,
            'facets' => $available,
        ];
    }

    /**
     * @param  Collection<int, array<string, mixed>>  $items
     * @param  array{sources?: list<string>, accounts?: list<int>, areas?: list<string>, kinds?: list<string>}  $filters
     * @return Collection<int, array<string, mixed>>
     */
    private function filter(Collection $items, array $filters): Collection
    {
        return $items
            ->when(! empty($filters['sources']), fn ($c) => $c->filter(fn ($i) => in_array($i['source'], $filters['sources'], true)))
            ->when(! empty($filters['accounts']), fn ($c) => $c->filter(fn ($i) => $i['account_id'] === null ? in_array(0, $filters['accounts'], true) : in_array($i['account_id'], $filters['accounts'], true)))
            ->when(! empty($filters['areas']), fn ($c) => $c->filter(fn ($i) => in_array($i['area'] ?? 'unassigned', $filters['areas'], true)))
            ->when(! empty($filters['kinds']), fn ($c) => $c->filter(fn ($i) => in_array($i['kind'], $filters['kinds'], true)));
    }

    /**
     * Filter options that actually have data, with counts.
     *
     * @param  Collection<int, array<string, mixed>>  $items
     * @return array<string, mixed>
     */
    private function facets(Collection $items, Collection $accounts, Collection $labels): array
    {
        return [
            'sources' => $items->groupBy('source')->map(fn ($g, $s) => ['key' => $s, 'label' => $s === 'lifeos' ? 'LifeOS' : ($labels[$s] ?? $s), 'count' => $g->count()])->values(),
            'accounts' => $accounts->map(fn ($a) => ['id' => $a->id, 'provider' => $a->provider, 'label' => $a->email ?? $a->display_name ?? ($labels[$a->provider] ?? $a->provider), 'source_label' => $labels[$a->provider] ?? $a->provider, 'status' => $a->status, 'count' => $items->where('account_id', $a->id)->count()])->values(),
            'areas' => collect([...self::AREAS, 'unassigned'])->map(fn ($a) => ['key' => $a, 'count' => $items->filter(fn ($i) => ($i['area'] ?? 'unassigned') === $a)->count()])->values(),
            'kinds' => collect(self::KINDS)->map(fn ($k) => ['key' => $k, 'count' => $items->where('kind', $k)->count()])->values(),
        ];
    }
}
