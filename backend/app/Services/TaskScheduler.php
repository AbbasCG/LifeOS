<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use DateTimeInterface;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * The single place that decides whether a task may get another calendar session.
 *
 * Policy: an ordinary task has at most ONE active session. A session is a non-recurring CalendarEvent linked to the task
 * (calendar_events.task_id) whose end lies in the future. A task the user explicitly works in several blocks (tasks.split_sessions,
 * set when a multi-block plan is accepted) may have several.
 *
 * Every creation path calls guardNewSession() inside its own transaction: it locks the task row (SELECT ... FOR UPDATE on PostgreSQL), so two
 * requests for the same task are serialised, and the second one sees the first one's committed session and is refused. SQLite (tests) has no row
 * locks; it serialises writers by itself.
 */
class TaskScheduler
{
    /**
     * @return Builder<CalendarEvent>
     */
    public function activeSessionsQuery(int $userId, int|iterable $taskIds): Builder
    {
        return CalendarEvent::where('user_id', $userId)
            ->whereIn('task_id', is_int($taskIds) ? [$taskIds] : collect($taskIds)->all())
            ->whereNull('recurrence')
            ->where('ends_at', '>', now())
            ->orderBy('starts_at')
            ->orderBy('id');
    }

    /**
     * Active sessions of several tasks in one query, earliest first.
     *
     * @param  iterable<int>  $taskIds
     * @return Collection<int, Collection<int, CalendarEvent>> keyed by task id
     */
    public function activeSessions(int $userId, iterable $taskIds): Collection
    {
        $ids = collect($taskIds)->unique()->values();
        if ($ids->isEmpty()) {
            return collect();
        }

        return $this->activeSessionsQuery($userId, $ids)->get()->groupBy('task_id');
    }

    /**
     * The `schedule` object of the Task JSON (null when the task has no active session), for each of the given tasks, without N+1.
     *
     * @param  Collection<int, Task>  $tasks
     * @return array<int, array{session_id: int, starts_at: string, ends_at: string, sessions: int, split: bool}|null> keyed by task id
     */
    public function schedules(int $userId, Collection $tasks): array
    {
        $sessions = $this->activeSessions($userId, $tasks->pluck('id'));

        return $tasks->mapWithKeys(fn (Task $task) => [$task->id => $this->schedulePayload($task, $sessions->get($task->id, collect()))])->all();
    }

    /**
     * @param  Collection<int, CalendarEvent>  $sessions  active sessions, earliest first
     * @return array{session_id: int, starts_at: string, ends_at: string, sessions: int, split: bool}|null
     */
    public function schedulePayload(Task $task, Collection $sessions): ?array
    {
        $first = $sessions->first();

        return $first ? ['session_id' => $first->id, 'starts_at' => self::iso($first->starts_at), 'ends_at' => self::iso($first->ends_at), 'sessions' => $sessions->count(), 'split' => (bool) $task->split_sessions] : null;
    }

    /**
     * Put `schedule` on the tasks, so their JSON carries it.
     *
     * @param  Collection<int, Task>  $tasks
     */
    public function attachSchedules(int $userId, Collection $tasks): void
    {
        $schedules = $this->schedules($userId, $tasks);
        $tasks->each(fn (Task $task) => $task->setAttribute('schedule', $schedules[$task->id]));
    }

    /**
     * @return array{session_id: int, starts_at: string, ends_at: string, sessions: int, split: bool}|null
     */
    public function scheduleOf(Task $task): ?array
    {
        return $this->schedulePayload($task, $this->activeSessionsQuery($task->user_id, $task->id)->get());
    }

    /**
     * Lock the user's task row and refuse when it is an ordinary task that already has an active session (other than $ignoreEventId).
     * Must be called inside a transaction: the row lock lasts until it ends. Returns the locked task.
     *
     * @throws TaskScheduleException task_already_scheduled (409)
     */
    public function guardNewSession(User $user, int $taskId, ?int $ignoreEventId = null): Task
    {
        $task = Task::where('user_id', $user->id)->whereKey($taskId)->lockForUpdate()->firstOrFail();
        $this->assertCanAdd($task, $this->activeSessionsQuery($user->id, $task->id)->when($ignoreEventId, fn ($q) => $q->where('id', '!=', $ignoreEventId))->get());

        return $task;
    }

    /**
     * @param  Collection<int, CalendarEvent>  $active  the task's active sessions, earliest first
     *
     * @throws TaskScheduleException task_already_scheduled (409)
     */
    public function assertCanAdd(Task $task, Collection $active, bool $resetIdleSplit = true): void
    {
        if ($resetIdleSplit) {
            $this->resetIdleSplit($task, $active);
        }
        if ($task->split_sessions || $active->isEmpty()) {
            return;
        }
        $session = $active->first();

        throw new TaskScheduleException('task_already_scheduled', 'This task is already scheduled. Move the existing session instead of adding another.', 409, ['session' => $this->sessionPayload($session)]);
    }

    /**
     * @return array{id: int, starts_at: string, ends_at: string, task_id: int|null}
     */
    public function sessionPayload(CalendarEvent $session): array
    {
        return ['id' => $session->id, 'starts_at' => self::iso($session->starts_at), 'ends_at' => self::iso($session->ends_at), 'task_id' => $session->task_id];
    }

    /**
     * Whether an event is an active session of its task (linked, non-recurring, not over).
     */
    public function isActiveSession(CalendarEvent $event): bool
    {
        return $event->task_id !== null && ! $event->isRecurring() && $event->ends_at > now();
    }

    /**
     * A split task whose sessions are all over starts a new cycle: it is an ordinary task again (one session) until another multi-block plan is accepted.
     *
     * @param  Collection<int, CalendarEvent>  $active
     */
    public function resetIdleSplit(Task $task, Collection $active): void
    {
        if ($task->split_sessions && $active->isEmpty()) {
            $this->setSplit($task, false);
        }
    }

    /**
     * Whether the task is a closed one that cannot be scheduled any more.
     */
    public function isClosed(Task $task): bool
    {
        return in_array($task->status, ['completed', 'cancelled'], true);
    }

    /**
     * Mark a task as explicitly worked in several blocks. Only for an accepted multi-block plan.
     */
    public function markSplit(Task $task): void
    {
        if (! $task->split_sessions) {
            $this->setSplit($task, true);
        }
    }

    private function setSplit(Task $task, bool $split): void
    {
        // Straight to the table: a flag flip is not an edit of the task, so updated_at (the stale-proposal check) stays as it was.
        Task::whereKey($task->id)->toBase()->update(['split_sessions' => $split]);
        $task->setAttribute('split_sessions', $split)->syncOriginalAttribute('split_sessions');
    }

    /**
     * Lock several of the user's tasks in a fixed order (by id), so two multi-row lockers can never wait on each other.
     * Lock order across the app: user row, proposal row, task rows (ascending id), then calendar rows.
     *
     * @param  iterable<int>  $taskIds
     * @return Collection<int, Task> keyed by id
     */
    public function lockTasks(int $userId, iterable $taskIds): Collection
    {
        return Task::where('user_id', $userId)->whereIn('id', collect($taskIds)->unique()->values()->all())->orderBy('id')->lockForUpdate()->get()->keyBy('id');
    }

    public static function iso(DateTimeInterface $at): string
    {
        return CarbonImmutable::instance($at)->utc()->toIso8601ZuluString();
    }
}
