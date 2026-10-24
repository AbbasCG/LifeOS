<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class FocusSession extends Model
{
    use HasFactory;

    public const MODES = ['pomodoro', 'deep', 'custom'];

    public const DISTRACTIONS = ['phone', 'people', 'notifications', 'thought', 'other'];

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['resumed_at' => 'immutable_datetime', 'completed_at' => 'immutable_datetime', 'started_at' => 'immutable_datetime', 'interruptions' => 'array'];
    }

    /** @return BelongsTo<Task, $this> */
    public function task(): BelongsTo
    {
        return $this->belongsTo(Task::class);
    }

    /** @return BelongsTo<Project, $this> */
    public function project(): BelongsTo
    {
        return $this->belongsTo(Project::class);
    }
}
