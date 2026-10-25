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
        return ['due_at' => 'immutable_datetime', 'remind_at' => 'immutable_datetime', 'scheduled_start' => 'immutable_datetime', 'scheduled_end' => 'immutable_datetime', 'completed_at' => 'immutable_datetime', 'subtasks' => 'array', 'tags' => 'array', 'last_postponed_at' => 'immutable_datetime'];
    }

    /**
     * A deadline moved later by more than an hour counts as a postponement (whoever moved it), so repeatedly deferred
     * work can be noticed. Moving a deadline earlier, setting a first deadline or removing it is not a postponement.
     */
    protected static function booted(): void
    {
        static::updating(function (Task $task) {
            $before = $task->getOriginal('due_at');
            if ($task->isDirty('due_at') && $before && $task->due_at && $task->due_at->getTimestamp() > $before->getTimestamp() + 3600) {
                $task->postponed_count = min(65535, (int) $task->postponed_count + 1);
                $task->last_postponed_at = now();
            }
        });
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
        // A new occurrence has not been postponed yet.
        $next->postponed_count = 0;
        $next->last_postponed_at = null;
        $next->due_at = ($this->due_at ?? CarbonImmutable::now())->addDays($this->recurrence === 'weekly' ? 7 : 1);
        $next->subtasks = collect($this->subtasks ?? [])->map(fn ($s) => ['title' => $s['title'], 'completed' => false])->all();
        $next->save();

        return $next;
    }
}
