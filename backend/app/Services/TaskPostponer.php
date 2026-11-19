<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * Smart postpone: one tap moves a task to tomorrow, to the start of next week or to a chosen date, and can be undone for UNDO_MINUTES.
 *
 * Rules, in order:
 * 1. Completed and cancelled tasks are never touched (422 task_closed).
 * 2. The target day is the next local day (tomorrow), the first day of the user's next week (next_week, User::startOfWeek) or the given date.
 * 3. A task with an active session: that session (the next upcoming one of a split task) keeps its row and its exact length and moves to the first
 *    free slot of the target day by FreeSlots (work hours, Ramadan hours, busy time of every calendar, breaks, prayer/iftar windows), never earlier
 *    than its own end or 15 minutes from now; with no room that day, the next work days (at most LOOKAHEAD_WORK_DAYS more). No room at all: 422 with
 *    the structured `conflict`. A fixed session or one copied to a connected calendar is not moved from here (422). Its deadline moves too only when
 *    it falls before the day the session lands on (to that day, by rule 4).
 * 4. A task without a session: only the deadline moves, to the target day. A date-only deadline stays date-only (end of that local day), a timed
 *    one keeps its local clock time. No deadline: 422 nothing_to_postpone. A deadline already on or after that moment: 422 already_later.
 * 5. A deadline moved later counts once in postponed_count through the Task model's rule; a session move alone does not count.
 *
 * Everything runs inside CalendarBooking::run (user lock, then the task row), so concurrent writes of the same user are one after the other.
 */
class TaskPostponer
{
    public const TARGETS = ['tomorrow', 'next_week', 'suggest', 'date'];

    public const UNDO_MINUTES = 10;

    /** Work days after the target day that may still take the session. */
    public const LOOKAHEAD_WORK_DAYS = 5;

    /** A suggestion of a deadline-only task looks for room for a session of this many minutes at most (and at least 15). */
    public const SUGGEST_MAX_MINUTES = 120;

    public const IDEMPOTENCY_SECONDS = 600;

    /** The same request again within this window, on the state it produced, is a double tap: the first result is returned, nothing moves again. */
    public const DOUBLE_TAP_SECONDS = 15;

    public function __construct(private PlanningService $planning, private FreeSlots $slots, private TaskScheduler $scheduler, private CalendarBooking $booking, private CalendarService $calendar, private AuditLogger $audit) {}

    /**
     * The target local day of 'tomorrow', 'next_week' or 'date'.
     */
    public function targetDay(User $user, string $to, ?string $date, string $tz): CarbonImmutable
    {
        $today = CarbonImmutable::now($tz)->startOfDay();

        return match ($to) {
            'tomorrow' => $today->addDay(),
            'next_week' => $user->startOfWeek($today)->addWeek(),
            default => CarbonImmutable::parse((string) $date, $tz)->startOfDay(),
        };
    }

    /**
     * The task's deadline carried to a local day: the end of that day for a date-only deadline, the same local clock time for a timed one.
     */
    public static function dueOn(Task $task, CarbonImmutable $day, string $tz): ?CarbonImmutable
    {
        if (! $task->due_at) {
            return null;
        }
        $day = $day->setTimezone($tz)->startOfDay();
        if ($task->due_all_day) {
            return Task::endOfDay($day->toDateString(), $tz);
        }
        $local = $task->due_at->setTimezone($tz);

        return $day->setTime($local->hour, $local->minute, $local->second)->utc();
    }

    /**
     * The best target over the next LOOKAHEAD_WORK_DAYS work days, without writing anything. With a session: the first day with a free slot of its
     * length. Without one: the first day with room for a session of the remaining estimate (15 to SUGGEST_MAX_MINUTES minutes); when no day has room,
     * the next work day with has_room false.
     *
     * @return array{to: string, date: string, starts_at: ?string, ends_at: ?string, due_at: ?string, due_all_day: bool, has_room: bool}
     */
    public function suggest(User $user, Task $task): array
    {
        $this->assertOpen($task);
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $tomorrow = $now->startOfDay()->addDay();
        $session = $this->scheduler->activeSessionsQuery($user->id, $task->id)->first();
        if ($session) {
            $plan = $this->plan($user, $task, $tomorrow, self::LOOKAHEAD_WORK_DAYS, $c, $now);
            $day = $plan['slot'][2];
            $room = true;
        } else {
            $this->deadlineOf($task);
            $seconds = 60 * (int) max(15, min(self::SUGGEST_MAX_MINUTES, (int) ceil(max(0, $task->estimated_minutes - (int) $task->actual_minutes) / 5) * 5));
            $days = $this->slots->days($user, $c, $tomorrow, self::LOOKAHEAD_WORK_DAYS, FreeSlots::earliest($now));
            $fit = $this->slots->take($days, $seconds, $c['break']);
            $room = $fit !== null;
            $day = $fit[2] ?? ($days[0]['local'] ?? $tomorrow);
            $plan = $this->plan($user, $task, $day, 0, $c, $now);
        }

        return [
            'to' => 'date', 'date' => $day->toDateString(),
            'starts_at' => isset($plan['slot']) ? TaskScheduler::iso($plan['slot'][0]) : null, 'ends_at' => isset($plan['slot']) ? TaskScheduler::iso($plan['slot'][1]) : null,
            'due_at' => isset($plan['due']) ? TaskScheduler::iso($plan['due']) : null, 'due_all_day' => isset($plan['due']) && $task->due_all_day, 'has_room' => $room,
        ];
    }

    /**
     * Postpone the task and return what moved and the undo token. A replay of the same Idempotency-Key, or the same request again within
     * DOUBLE_TAP_SECONDS, returns the first result and moves nothing.
     *
     * @param  array{to: string, date?: string|null, expected_updated_at?: string|null}  $data
     * @return array{task_id: int, undo: array{token: string, expires_at: string}, moved: array<string, mixed>, replayed: bool}
     */
    public function postpone(User $user, int $taskId, array $data, ?string $idempotencyKey, ?Request $request = null): array
    {
        $result = $this->booking->run($user, [$taskId], function (Collection $tasks) use ($user, $taskId, $data, $idempotencyKey) {
            /** @var Task $task */
            $task = $tasks->get($taskId);
            $bodyHash = hash('sha256', json_encode([$data['to'], $data['date'] ?? null, $data['expected_updated_at'] ?? null]));
            $keyCache = $idempotencyKey ? 'task-postpone-idempotency:'.$user->id.':'.$task->id.':'.hash('sha256', $idempotencyKey) : null;
            if ($keyCache && is_array($first = Cache::get($keyCache))) {
                if ($first['hash'] !== $bodyHash) {
                    $message = 'This Idempotency-Key was already used with a different request.';

                    throw new TaskScheduleException('idempotency_key_reused', $message, 422, ['errors' => ['idempotency_key' => [$message]]]);
                }

                return ['replayed' => true] + $first['result'];
            }
            $tapCache = 'task-postpone-last:'.$user->id.':'.$task->id;
            $last = Cache::get($tapCache);
            if (is_array($last) && $last['hash'] === $bodyHash && $last['state'] === $this->state($user, $task)) {
                return ['replayed' => true] + $last['result'];
            }

            $this->assertOpen($task);
            if (! empty($data['expected_updated_at']) && ! $task->updated_at?->equalTo(CarbonImmutable::parse($data['expected_updated_at']))) {
                throw new TaskScheduleException('task_changed', 'This task was changed in the meantime. Reload and try again.', 409, ['current' => ['updated_at' => $task->updated_at?->toIso8601ZuluString()]]);
            }
            $c = $this->planning->config($user);
            $now = CarbonImmutable::now($c['tz']);
            $target = $this->targetDay($user, $data['to'], $data['date'] ?? null, $c['tz']);
            $workDays = (in_array($target->dayOfWeek, $c['work_days'], true) ? 1 : 0) + self::LOOKAHEAD_WORK_DAYS;
            $plan = $this->plan($user, $task, $target, $workDays, $c, $now);

            $undo = ['task_id' => $task->id, 'before' => [
                'due_at' => $task->due_at?->toIso8601String(), 'due_all_day' => (bool) $task->due_all_day,
                'postponed_count' => (int) $task->postponed_count, 'last_postponed_at' => $task->last_postponed_at?->toIso8601String(),
            ]];
            $moved = [];
            if (isset($plan['session'])) {
                /** @var CalendarEvent $event */
                $event = CalendarEvent::where('user_id', $user->id)->whereKey($plan['session']->id)->lockForUpdate()->firstOrFail();
                [$start, $end] = $plan['slot'];
                $this->booking->assertFree($user, $start, $end, $event->id, null, 'to');
                $moved['session'] = ['session_id' => $event->id, 'from_starts_at' => TaskScheduler::iso($event->starts_at), 'from_ends_at' => TaskScheduler::iso($event->ends_at), 'starts_at' => TaskScheduler::iso($start), 'ends_at' => TaskScheduler::iso($end)];
                $event->update(['starts_at' => $start, 'ends_at' => $end]);
            }
            if (isset($plan['due'])) {
                $moved['due'] = ['from' => TaskScheduler::iso($task->due_at), 'to' => TaskScheduler::iso($plan['due']), 'due_all_day' => (bool) $task->due_all_day];
                // The flag is set in the same save, so the model keeps a date-only deadline date-only; its updating hook counts the postponement once.
                $task->forceFill(['due_at' => $plan['due'], 'due_all_day' => (bool) $task->due_all_day])->save();
            } else {
                // A moved session is a change of the task too (plans and open tabs that saw the old state are stale now).
                $task->touch();
            }
            $task->refresh();
            $undo['moved'] = $moved;
            $undo['after_due_at'] = $task->due_at?->toIso8601String();
            $token = Str::random(40);
            $expires = now()->addMinutes(self::UNDO_MINUTES);
            Cache::put($this->undoKey($user, $token), $undo, $expires);
            $result = ['task_id' => $task->id, 'undo' => ['token' => $token, 'expires_at' => $expires->toIso8601ZuluString()], 'moved' => (object) $moved];
            if ($keyCache) {
                Cache::put($keyCache, ['hash' => $bodyHash, 'result' => $result], self::IDEMPOTENCY_SECONDS);
            }
            Cache::put($tapCache, ['hash' => $bodyHash, 'state' => $this->state($user, $task), 'result' => $result], self::DOUBLE_TAP_SECONDS);

            return ['replayed' => false] + $result;
        });
        if (! $result['replayed']) {
            $this->audit->log($user, 'task_postponed', $request, ['task' => $taskId, 'to' => $data['to'], 'session' => isset(((array) $result['moved'])['session']), 'due' => isset(((array) $result['moved'])['due'])]);
        }

        return $result;
    }

    /**
     * Put the session and the deadline back exactly as they were, once, within UNDO_MINUTES, for the owner only. Refused (nothing changes) when
     * either was changed since (409 changed_since) or the old slot is taken now (422 with the structured `conflict`).
     */
    public function undo(User $user, int $taskId, string $token, ?Request $request = null): void
    {
        $this->booking->run($user, [$taskId], function (Collection $tasks) use ($user, $taskId, $token) {
            /** @var Task $task */
            $task = $tasks->get($taskId);
            $key = $this->undoKey($user, $token);
            $state = Cache::get($key);
            if (! is_array($state) || (int) $state['task_id'] !== $task->id) {
                $message = 'This postponement can no longer be undone.';

                throw new TaskScheduleException('undo_unavailable', $message, 422, ['errors' => ['token' => [$message]]]);
            }
            $this->assertOpen($task);
            $changed = fn () => throw new TaskScheduleException('changed_since', 'This task was changed after it was postponed, so it is not put back.', 409);
            if ($task->due_at?->toIso8601String() !== $state['after_due_at']) {
                $changed();
            }
            if ($session = $state['moved']['session'] ?? null) {
                $event = CalendarEvent::where('user_id', $user->id)->whereKey($session['session_id'])->lockForUpdate()->first();
                if (! $event || TaskScheduler::iso($event->starts_at) !== $session['starts_at'] || TaskScheduler::iso($event->ends_at) !== $session['ends_at'] || (int) $event->task_id !== $task->id) {
                    $changed();
                }
                $from = CarbonImmutable::parse($session['from_starts_at']);
                $to = CarbonImmutable::parse($session['from_ends_at']);
                $this->booking->assertFree($user, $from, $to, $event->id, null, 'token', fn (array $c) => "The original time now overlaps “{$c['title']}”, so the session is not put back.");
                $event->update(['starts_at' => $from, 'ends_at' => $to]);
            }
            $before = $state['before'];
            $tz = $user->timezone();
            $due = $before['due_at'] ? CarbonImmutable::parse($before['due_at'])->utc() : null;
            $allDay = $due && $before['due_all_day'] && $due->equalTo(Task::endOfDay($due->setTimezone($tz)->toDateString(), $tz));
            $task->forceFill(['due_at' => $due, 'due_all_day' => $allDay, 'postponed_count' => $before['postponed_count'], 'last_postponed_at' => $before['last_postponed_at'] ? CarbonImmutable::parse($before['last_postponed_at']) : null])->save();
            Cache::forget($key);
            Cache::forget('task-postpone-last:'.$user->id.':'.$task->id);
        });
        $this->audit->log($user, 'task_postpone_undone', $request, ['task' => $taskId]);
    }

    /**
     * What a postpone to $first would do, computed under the caller's locks (or read-only for a suggestion).
     *
     * @param  array<string, mixed>  $c
     * @return array{session?: CalendarEvent, slot?: array{0: CarbonImmutable, 1: CarbonImmutable, 2: CarbonImmutable}, due?: CarbonImmutable}
     */
    private function plan(User $user, Task $task, CarbonImmutable $first, int $workDays, array $c, CarbonImmutable $now): array
    {
        // A split task: only its next upcoming session moves (the earliest active one); the others stay where they are.
        $session = $this->scheduler->activeSessionsQuery($user->id, $task->id)->first();
        if (! $session) {
            $due = $this->deadlineOf($task);
            $new = self::dueOn($task, $first, $c['tz']);
            if ($new <= $due) {
                $message = 'The deadline is already on or after that day.';

                throw new TaskScheduleException('already_later', $message, 422, ['errors' => ['to' => [$message]]]);
            }

            return ['due' => $new];
        }
        if ($session->kind === 'fixed') {
            $message = 'This session is a fixed commitment. Move it from the calendar.';

            throw new TaskScheduleException('session_fixed', $message, 422, ['errors' => ['to' => [$message]], 'session' => $this->scheduler->sessionPayload($session)]);
        }
        if (CalendarWriteLink::where('user_id', $user->id)->where('calendar_event_id', $session->id)->exists()) {
            $message = 'This session was copied to a connected calendar, so it is not moved from here.';

            throw new TaskScheduleException('session_linked', $message, 422, ['errors' => ['to' => [$message]], 'session' => $this->scheduler->sessionPayload($session)]);
        }
        $seconds = (int) $session->starts_at->diffInSeconds($session->ends_at);
        // Postponing never moves a session earlier: it starts after its own end at the soonest.
        $notBefore = max(FreeSlots::earliest($now), $session->ends_at->setTimezone($c['tz']));
        $days = $this->slots->days($user, $c, $first, $workDays, $notBefore, $session->id);
        $slot = $this->slots->take($days, $seconds, $c['break']);
        if (! $slot) {
            $this->noRoom($user, $c, $first, $seconds, $session);
        }
        $plan = ['session' => $session, 'slot' => $slot];
        if ($task->due_at && $task->due_at < $slot[2]->utc()) {
            $plan['due'] = self::dueOn($task, $slot[2], $c['tz']);
        }

        return $plan;
    }

    private function deadlineOf(Task $task): CarbonImmutable
    {
        if (! $task->due_at) {
            $message = 'This task has no session and no deadline, so there is nothing to postpone.';

            throw new TaskScheduleException('nothing_to_postpone', $message, 422, ['errors' => ['to' => [$message]]]);
        }

        return $task->due_at;
    }

    /**
     * No free slot on the target day nor on the next work days: the structured conflict of the first slot that was wanted.
     *
     * @param  array<string, mixed>  $c
     *
     * @throws ScheduleConflictException
     */
    private function noRoom(User $user, array $c, CarbonImmutable $first, int $seconds, CalendarEvent $session): never
    {
        $day = $first->setTimezone($c['tz'])->startOfDay();
        $start = max($day->setTimeFromTimeString($this->planning->workHours($c, $day)[0]), FreeSlots::earliest(CarbonImmutable::now($c['tz'])))->utc();
        $end = $start->addSeconds($seconds);
        $items = $this->calendar->conflicts($user, $start, $end, $session->id)->map(fn (array $o) => [$o, $start, $end])->all();
        $message = 'There is no free time for this session on '.$day->toDateString().' or the next '.self::LOOKAHEAD_WORK_DAYS.' work days.';

        throw ScheduleConflictException::make('to', $message, $this->booking->payload($start, $end, $items, $this->booking->suggestSlot($user, $start, $end, $session->id)));
    }

    private function assertOpen(Task $task): void
    {
        if ($this->scheduler->isClosed($task)) {
            $message = 'A completed or cancelled task cannot be postponed.';

            throw new TaskScheduleException('task_closed', $message, 422, ['errors' => ['task' => [$message]]]);
        }
    }

    /** What a double tap is compared with: the task's deadline and its next session, as they are now. */
    private function state(User $user, Task $task): string
    {
        $session = $this->scheduler->activeSessionsQuery($user->id, $task->id)->first();

        return implode('|', [$task->due_at?->toIso8601String(), $session?->id, $session ? TaskScheduler::iso($session->starts_at) : '', $session ? TaskScheduler::iso($session->ends_at) : '']);
    }

    private function undoKey(User $user, string $token): string
    {
        return 'task-postpone-undo:'.$user->id.':'.hash('sha256', $token);
    }
}
