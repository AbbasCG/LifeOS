<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class FocusSession extends Model
{
    use HasFactory;

    public const MODES = ['pomodoro', 'deep', 'custom'];

    public const DISTRACTIONS = ['phone', 'people', 'notifications', 'thought', 'other'];

    protected $guarded = ['id'];

    protected $appends = ['server_time'];

    /** The server's clock when the record is sent, so the app can count down by it even if the device clock is off. */
    protected function serverTime(): Attribute
    {
        return Attribute::get(fn (): string => now()->toIso8601String());
    }

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
