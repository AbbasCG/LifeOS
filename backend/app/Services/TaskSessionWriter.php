<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

/**
 * The `schedule` key of POST /api/tasks and PATCH /api/tasks/{id}: the task's ONE active session is booked, moved or removed in the same
 * transaction as the task's own fields, so a refused time can never leave a half-saved edit behind.
 *
 * Must be called inside CalendarBooking::run (user row and the task row are locked) after the task row has been written. Anything it throws
 * (ScheduleConflictException, TaskScheduleException, ValidationException) rolls the whole save back. The overlap rule is CalendarBooking::assertFree,
 * the session rules are TaskScheduler's; nothing of them is repeated here.
 */
class TaskSessionWriter
{
    public const DEFAULT_MINUTES = 30;

    public function __construct(private CalendarBooking $booking, private TaskScheduler $scheduler) {}

    /**
     * @param  array{starts_at?: string, ends_at?: string|null, session_id?: int|null, expected_starts_at?: string|null, confirm_fixed?: bool}|null  $schedule  null removes the session
     *
     * @throws ScheduleConflictException the time overlaps something (422)
     * @throws TaskScheduleException several_sessions (422), session_not_found (404), event_changed (409)
     * @throws ValidationException closed task, end not in the future
     */
    public function apply(User $user, Task $task, ?array $schedule): void
    {
        $active = $this->scheduler->activeSessionsQuery($user->id, $task->id)->get();
        $sessionId = isset($schedule['session_id']) ? (int) $schedule['session_id'] : null;

        if ($schedule === null) {
            $session = $this->target($active, $sessionId);
            if ($session) {
                $this->lock($user, $session)->delete();
            }

            return;
        }
        if ($this->scheduler->isClosed($task)) {
            throw ValidationException::withMessages(['schedule' => ['A completed or cancelled task cannot be scheduled.']]);
        }
        $session = $this->target($active, $sessionId);
        $start = CarbonImmutable::parse($schedule['starts_at'])->utc();
        // The server is the single source of the end: the task's length as it is AFTER this request's fields were applied.
        $end = ! empty($schedule['ends_at']) ? CarbonImmutable::parse($schedule['ends_at'])->utc() : $start->addMinutes((int) ($task->estimated_minutes ?: self::DEFAULT_MINUTES));
        if ($end <= $start) {
            throw ValidationException::withMessages(['schedule.ends_at' => ['End must follow start.']]);
        }
        if ($end <= CarbonImmutable::now()) {
            throw ValidationException::withMessages(['schedule.ends_at' => ['The session must end in the future.']]);
        }

        if (! $session) {
            $this->scheduler->assertCanAdd($task, $active);
            $this->booking->assertFree($user, $start, $end);
            CalendarEvent::create(['user_id' => $user->id, 'task_id' => $task->id, 'title' => mb_substr($task->title, 0, 200), 'kind' => 'flexible', 'starts_at' => $start, 'ends_at' => $end]);

            return;
        }
        $event = $this->lock($user, $session);
        $expected = $schedule['expected_starts_at'] ?? null;
        if ($expected !== null && ! $event->starts_at->equalTo(CarbonImmutable::parse($expected)->utc())) {
            throw new TaskScheduleException('event_changed', 'This event was moved in the meantime. Reload to see its current time.', 409, ['current' => $this->scheduler->sessionPayload($event)]);
        }
        if ($event->starts_at->equalTo($start) && $event->ends_at->equalTo($end)) {
            return;
        }
        if ($event->kind === 'fixed' && empty($schedule['confirm_fixed'])) {
            throw ValidationException::withMessages(['fixed' => ['This is a fixed commitment. Confirm before changing its time.']]);
        }
        // The task's own session is not a conflict with itself.
        $this->booking->assertFree($user, $start, $end, $event->id);
        $event->forceFill(['starts_at' => $start, 'ends_at' => $end])->save();
    }

    /**
     * The session a request means: the one named by session_id, else the only one; null when the task has none.
     *
     * @param  Collection<int, CalendarEvent>  $active
     *
     * @throws TaskScheduleException
     */
    private function target(Collection $active, ?int $sessionId): ?CalendarEvent
    {
        if ($sessionId !== null) {
            return $active->firstWhere('id', $sessionId) ?? throw new TaskScheduleException('session_not_found', 'That session is not an active session of this task.', 404);
        }
        if ($active->count() > 1) {
            $message = 'This task has several sessions. Say which one with schedule.session_id.';

            throw new TaskScheduleException('several_sessions', $message, 422, ['errors' => ['schedule' => [$message]], 'sessions' => $active->map(fn (CalendarEvent $s) => $this->scheduler->sessionPayload($s))->all()]);
        }

        return $active->first();
    }

    private function lock(User $user, CalendarEvent $session): CalendarEvent
    {
        return CalendarEvent::where('user_id', $user->id)->whereKey($session->id)->lockForUpdate()->firstOrFail();
    }
}
