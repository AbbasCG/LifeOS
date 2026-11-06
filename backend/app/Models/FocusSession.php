<?php

namespace App\Models;

use Carbon\CarbonInterface;
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

    protected $appends = ['server_time', 'elapsed_now_seconds', 'overdue_seconds'];

    /** The server's clock when the record is sent, so the app can count down by it even if the device clock is off. */
    protected function serverTime(): Attribute
    {
        return Attribute::get(fn (): string => now()->toIso8601String());
    }

    protected function casts(): array
    {
        return ['resumed_at' => 'immutable_datetime', 'completed_at' => 'immutable_datetime', 'started_at' => 'immutable_datetime', 'interruptions' => 'array'];
    }

    /**
     * Seconds this running session has accrued since its time was last accounted for. Two clocks must agree and the smaller one wins:
     * `resumed_at` (a `timestamp with time zone`: a database whose own zone is not UTC can store it hours early) and `updated_at` (stored
     * without a zone, so exact), which every action that sets `resumed_at` writes at the same moment. A session can therefore never
     * look older than it is, whatever the database's zone.
     */
    public function runningSeconds(CarbonInterface $now): int
    {
        if ($this->status !== 'running' || ! $this->resumed_at) {
            return 0;
        }
        $sinceResume = max(0, (int) $this->resumed_at->diffInSeconds($now, false));
        $sinceSave = $this->updated_at ? max(0, (int) $this->updated_at->diffInSeconds($now, false)) : $sinceResume;

        return min($sinceResume, $sinceSave);
    }

    /** Seconds worked so far, never more than the planned length and never more than the time since the session was created (pauses only reduce it). */
    public function elapsedAt(CarbonInterface $now): int
    {
        $sinceCreated = $this->created_at ? max(0, (int) $this->created_at->diffInSeconds($now, false)) : PHP_INT_MAX;

        return max(0, min((int) $this->duration_seconds, (int) $this->elapsed_seconds + $this->runningSeconds($now), $sinceCreated));
    }

    /** The worked time on the server's clock at the moment the record is sent; the page adds the seconds that pass after that. */
    protected function elapsedNowSeconds(): Attribute
    {
        return Attribute::get(fn (): int => $this->status === 'running' ? $this->elapsedAt(now()) : (int) $this->elapsed_seconds);
    }

    /** How many seconds past its planned end a running session is (0 while time is left). */
    protected function overdueSeconds(): Attribute
    {
        return Attribute::get(function (): int {
            if ($this->status !== 'running') {
                return 0;
            }
            $sinceCreated = $this->created_at ? max(0, (int) $this->created_at->diffInSeconds(now(), false)) : PHP_INT_MAX;

            return max(0, min((int) $this->elapsed_seconds + $this->runningSeconds(now()), $sinceCreated) - (int) $this->duration_seconds);
        });
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
