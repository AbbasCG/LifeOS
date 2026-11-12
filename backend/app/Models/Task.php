<?php

namespace App\Models;

use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Task extends Model
{
    use HasFactory;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['due_at' => 'immutable_datetime', 'remind_at' => 'immutable_datetime', 'scheduled_start' => 'immutable_datetime', 'scheduled_end' => 'immutable_datetime', 'completed_at' => 'immutable_datetime', 'subtasks' => 'array', 'tags' => 'array', 'last_postponed_at' => 'immutable_datetime', 'split_sessions' => 'boolean', 'due_all_day' => 'boolean'];
    }

    /**
     * A deadline moved later by more than an hour counts as a postponement (whoever moved it), so repeatedly deferred
     * work can be noticed. Moving a deadline earlier, setting a first deadline or removing it is not a postponement.
     */
    protected static function booted(): void
    {
        // due_all_day is only true while due_at is exactly the end of a day in the account timezone. A deadline without a time is never kept
        // on a task that has no deadline, and any code path that sets a different instant (assistant reschedule, import, a direct update) clears
        // the flag unless it sets the flag in the same save.
        static::saving(function (Task $task) {
            if (! $task->due_all_day) {
                return;
            }
            if (! $task->due_at) {
                $task->due_all_day = false;
            } elseif ($task->isDirty('due_at') && ! $task->isDirty('due_all_day')) {
                $tz = User::find($task->user_id)?->timezone() ?? 'UTC';
                if (! $task->due_at->equalTo(self::endOfDay($task->due_at->setTimezone($tz)->toDateString(), $tz))) {
                    $task->due_all_day = false;
                }
            }
        });
        static::updating(function (Task $task) {
            $before = $task->getOriginal('due_at');
            if ($task->isDirty('due_at') && $before && $task->due_at && $task->due_at->getTimestamp() > $before->getTimestamp() + 3600) {
                $task->postponed_count = min(65535, (int) $task->postponed_count + 1);
                $task->last_postponed_at = now();
            }
        });
    }

    /**
     * The instant a date-only deadline falls due: 23:59:00 on that calendar date in the given timezone (returned in UTC).
     */
    public static function endOfDay(string $date, string $tz): CarbonImmutable
    {
        return CarbonImmutable::parse($date.' 23:59:00', $tz)->utc();
    }

    /**
     * The calendar date (YYYY-MM-DD) of a date-only deadline in the account timezone, or null for a timed or missing deadline.
     */
    public function dueDate(string $tz): ?string
    {
        return $this->due_all_day && $this->due_at ? $this->due_at->setTimezone($tz)->toDateString() : null;
    }

    /**
     * Move a deadline by whole days. A date-only deadline keeps landing on the end of its local day (across DST changes); a timed one moves by
     * the same number of days in UTC, exactly as before.
     */
    public function addDaysToDue(CarbonImmutable $due, int $days): CarbonImmutable
    {
        if (! $this->due_all_day) {
            return $due->addDays($days);
        }
        $tz = User::find($this->user_id)?->timezone() ?? 'UTC';

        return self::endOfDay($due->setTimezone($tz)->addDays($days)->toDateString(), $tz);
    }

    /**
     * For a recurring task that was just completed, create the next open occurrence.
     */
    public function createNextOccurrence(): ?self
    {
        if (! $this->recurrence) {
            return null;
        }
        $next = $this->replicate(['completed_at', 'scheduled_start', 'scheduled_end']);
        $next->status = 'todo';
        $next->actual_minutes = 0;
        // A new occurrence is a new piece of work: it starts as an ordinary task with at most one session.
        $next->split_sessions = false;
        // A new occurrence has not been postponed yet.
        $next->postponed_count = 0;
        $next->last_postponed_at = null;
        $next->due_at = $this->addDaysToDue($this->due_at ?? CarbonImmutable::now(), $this->recurrence === 'weekly' ? 7 : 1);
        $next->due_all_day = $this->due_at && $this->due_all_day;
        $next->subtasks = collect($this->subtasks ?? [])->map(fn ($s) => ['title' => $s['title'], 'completed' => false])->all();
        $next->save();

        return $next;
    }
}
