<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Closure;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * The one place where a write to the calendar is made safe against overlaps.
 *
 * Every path that creates or moves a CalendarEvent (events API, task schedule API, assistant actions and their undo, plan acceptance) does its
 * overlap check and its write inside run(): one transaction that first takes the user's row lock, so two requests of the same user are strictly
 * one after the other no matter which tasks they are about. A transaction alone does not prevent overlap (two transactions can both read "free"
 * before either commits); the lock does, because the second request only checks after the first has committed.
 *
 * Lock order across the app: user row (User::lockForOrdering, FOR NO KEY UPDATE on PostgreSQL so inserts that reference the user never block on it), proposal row,
 * task rows (ascending id), then calendar rows. run() takes the user row and the task rows;
 * callers lock a proposal between the two only through their own transaction (it is taken inside the callback, after the user row, which keeps
 * the order). The planned-window sync of a task runs after commit, so no task lock is ever taken while a calendar row is locked.
 *
 * The overlap rule itself is CalendarService::overlaps (half-open [start, end), recurring and external events included).
 */
class CalendarBooking
{
    public const MAX_CONFLICTS = 5;

    public const SUGGEST_DAYS = 7;

    public function __construct(private CalendarService $calendar, private TaskScheduler $scheduler) {}

    /**
     * Run $callback in a transaction that holds the user's booking lock and the lock of the given tasks. The callback receives the locked tasks keyed by id.
     *
     * @template T
     *
     * @param  iterable<int|null>  $taskIds
     * @param  Closure(Collection<int, Task>): T  $callback
     * @return T
     */
    public function run(User $user, iterable $taskIds, Closure $callback): mixed
    {
        return DB::transaction(function () use ($user, $taskIds, $callback) {
            User::lockForOrdering($user->id);
            $ids = collect($taskIds)->filter()->map(fn ($id) => (int) $id)->unique()->sort()->values();
            $tasks = $ids->isEmpty() ? collect() : $this->scheduler->lockTasks($user->id, $ids);
            if ($tasks->count() !== $ids->count()) {
                throw (new ModelNotFoundException)->setModel(Task::class, $ids->diff($tasks->keys())->values()->all());
            }

            return $callback($tasks);
        });
    }

    /**
     * Refuse (ScheduleConflictException, 422) when [start, end) overlaps anything on the user's calendar, ignoring one event or one occurrence.
     *
     * @param  (Closure(array<string, mixed>): string)|string|null  $message  built from the first conflicting item; defaults to the standard English sentence
     *
     * @throws ScheduleConflictException
     */
    public function assertFree(User $user, CarbonImmutable $start, CarbonImmutable $end, ?int $ignoreEventId = null, ?CarbonImmutable $ignoreOccurrence = null, string $errorKey = 'starts_at', Closure|string|null $message = null): void
    {
        $conflicts = $this->calendar->conflicts($user, $start, $end, $ignoreEventId, $ignoreOccurrence);
        if ($conflicts->isEmpty()) {
            return;
        }
        $first = $conflicts->first();
        $text = $message instanceof Closure ? $message($first) : ($message ?? "This time conflicts with “{$first['title']}” ({$first['starts_at']->toIso8601String()} – {$first['ends_at']->toIso8601String()}). Choose another time.");

        throw ScheduleConflictException::make($errorKey, $text, $this->payload($start, $end, $conflicts->map(fn (array $o) => [$o, $start, $end])->all(), $this->suggestSlot($user, $start, $end, $ignoreEventId, $ignoreOccurrence)));
    }

    /**
     * Refuse a new or changed series when one of its occurrences in the next 90 days overlaps something (unless the request sets ignore_conflicts).
     * The conflict object names the first clashing occurrence as `requested`; a series has no single slot, so there is no suggestion.
     *
     * @throws ScheduleConflictException
     */
    public function assertSeriesFree(User $user, CalendarEvent $event): void
    {
        $clashes = $this->calendar->seriesConflicts($user, $event);
        if (! $clashes) {
            return;
        }
        $lines = collect($clashes)->map(fn (array $c) => "{$c['date']}: “{$c['title']}”")->implode('; ');
        $first = $clashes[0]['mine'];

        throw ScheduleConflictException::make('recurrence_conflicts', "This series overlaps existing events: {$lines}. Save anyway or choose another time.", $this->payload(
            $first['starts_at'], $first['ends_at'], array_map(fn (array $c) => [$c['clash'], $c['mine']['starts_at'], $c['mine']['ends_at']], $clashes), null,
        ));
    }

    /**
     * The `conflict` object of the 422 response.
     *
     * @param  list<array{0: array<string, mixed>, 1: CarbonImmutable, 2: CarbonImmutable}>  $items  conflicting item with the requested interval it overlaps
     * @param  array{starts_at: string, ends_at: string}|null  $suggestion
     * @return array<string, mixed>
     */
    public function payload(CarbonImmutable $start, CarbonImmutable $end, array $items, ?array $suggestion): array
    {
        $listed = collect($items)->sortBy(fn (array $i) => $i[0]['starts_at']->getTimestamp())->take(self::MAX_CONFLICTS)->map(fn (array $i) => $this->item($i[0], $i[1], $i[2]))->values()->all();

        return [
            'code' => ScheduleConflictException::CODE,
            'requested' => ['starts_at' => TaskScheduler::iso($start), 'ends_at' => TaskScheduler::iso($end)],
            'conflicts' => $listed,
            'suggestion' => $suggestion,
        ];
    }

    /**
     * The first slot of the same length, at or after the requested start and never in the past, that overlaps nothing (same overlap rule as the check)
     * and lies inside the user's working hours. Searched for SUGGEST_DAYS days; null when there is none.
     *
     * Known limitation: only the work window of work days is searched (study and personal windows are not), so a request outside working hours, e.g. at
     * 20:00, is answered with the next free slot inside working hours, not with the nearest free time on that evening. A work window whose end is not
     * after its start never fits anything and yields null for that day.
     *
     * @return array{starts_at: string, ends_at: string}|null
     */
    public function suggestSlot(User $user, CarbonImmutable $start, CarbonImmutable $end, ?int $ignoreEventId = null, ?CarbonImmutable $ignoreOccurrence = null): ?array
    {
        $seconds = (int) $start->diffInSeconds($end);
        $now = CarbonImmutable::now()->utc();
        $earliest = max($start->utc(), $now->microsecond === 0 && $now->second === 0 ? $now : $now->startOfMinute()->addMinute());
        $earliest = $earliest->microsecond > 0 ? $earliest->setMicrosecond(0)->addSecond() : $earliest;
        $horizon = $earliest->addDays(self::SUGGEST_DAYS);
        $planner = app(PlanningService::class);
        $config = $planner->config($user);
        // One read of everything that could be in the way; the loop below only filters it with the same overlap rule.
        $busy = $this->calendar->conflicts($user, $earliest, $horizon->addSeconds($seconds), $ignoreEventId, $ignoreOccurrence);
        $firstDay = $earliest->setTimezone($config['tz'])->startOfDay();
        for ($d = 0; $d <= self::SUGGEST_DAYS; $d++) {
            $window = $planner->windows($config, $firstDay->addDays($d))['work'] ?? null;
            if (! $window) {
                continue;
            }
            $cursor = max($window[0]->utc(), $earliest);
            $windowEnd = $window[1]->utc();
            while ($cursor < $horizon && $cursor->addSeconds($seconds) <= $windowEnd) {
                $candidateEnd = $cursor->addSeconds($seconds);
                $blocking = $busy->filter(fn (array $o) => CalendarService::overlaps($o, $cursor, $candidateEnd));
                if ($blocking->isEmpty()) {
                    return ['starts_at' => TaskScheduler::iso($cursor), 'ends_at' => TaskScheduler::iso($candidateEnd)];
                }
                $cursor = CarbonImmutable::instance($blocking->max(fn (array $o) => $o['ends_at']))->utc();
                $cursor = $cursor->microsecond > 0 ? $cursor->setMicrosecond(0)->addSecond() : $cursor;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $o  an occurrence from CalendarService::occurrences
     * @return array{id: int|null, event_id: int|null, task_id: int|null, title: string, kind: string, source: string, starts_at: string, ends_at: string, overlap_minutes: int}
     */
    private function item(array $o, CarbonImmutable $start, CarbonImmutable $end): array
    {
        $external = ($o['source'] ?? 'lifeos') !== 'lifeos';
        $eventId = $external ? null : ($o['event_id'] ?? null);
        $overlap = max($o['starts_at'], $start)->diffInSeconds(min($o['ends_at'], $end), true);

        return [
            'id' => $external ? (int) ltrim((string) $o['id'], 'x') : $eventId,
            'event_id' => $eventId,
            'task_id' => $o['task_id'] ?? null,
            'title' => (string) $o['title'],
            'kind' => $external ? 'external' : (($o['task_id'] ?? null) !== null ? 'task_session' : 'event'),
            'source' => (string) ($o['source'] ?? 'lifeos'),
            'starts_at' => TaskScheduler::iso($o['starts_at']),
            'ends_at' => TaskScheduler::iso($o['ends_at']),
            'overlap_minutes' => (int) ceil($overlap / 60),
        ];
    }
}
