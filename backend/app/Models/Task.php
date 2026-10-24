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
        return ['due_at' => 'immutable_datetime', 'remind_at' => 'immutable_datetime', 'scheduled_start' => 'immutable_datetime', 'scheduled_end' => 'immutable_datetime', 'completed_at' => 'immutable_datetime', 'subtasks' => 'array', 'tags' => 'array'];
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
        $next->due_at = ($this->due_at ?? CarbonImmutable::now())->addDays($this->recurrence === 'weekly' ? 7 : 1);
        $next->subtasks = collect($this->subtasks ?? [])->map(fn ($s) => ['title' => $s['title'], 'completed' => false])->all();
        $next->save();

        return $next;
    }
}
