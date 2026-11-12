<?php

namespace App\Models;

use App\Services\TaskScheduler;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\DB;

class CalendarEvent extends Model
{
    use HasFactory;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['starts_at' => 'immutable_datetime', 'ends_at' => 'immutable_datetime', 'recurrence' => 'array', 'recurrence_until' => 'date:Y-m-d'];
    }

    /**
     * tasks.scheduled_start/scheduled_end are the window of the task's planned sessions and ConflictService reads them. When a session is moved,
     * re-linked or deleted, the window of the task it belonged to must follow, otherwise a stale window keeps reporting a conflict that was just fixed.
     *
     * Lock order: the app locks the task row first and the calendar rows after it. The sync writes the task row, so it must never run while this
     * request still holds an event row lock: it is deferred until the surrounding transaction has committed (immediately when none is open).
     */
    protected static function booted(): void
    {
        $sync = function (CalendarEvent $event) {
            $userId = (int) $event->user_id;
            $taskIds = collect([$event->task_id, $event->getOriginal('task_id')])->filter()->unique()->map(fn ($id) => (int) $id)->sort()->values();
            DB::afterCommit(fn () => $taskIds->each(fn (int $taskId) => app(TaskScheduler::class)->syncPlannedWindow($userId, $taskId)));
        };
        static::saved($sync);
        static::deleted($sync);
    }

    /** @return HasMany<CalendarEventException, $this> */
    public function exceptions(): HasMany
    {
        return $this->hasMany(CalendarEventException::class);
    }

    public function isRecurring(): bool
    {
        return ! empty($this->recurrence['freq']);
    }
}
