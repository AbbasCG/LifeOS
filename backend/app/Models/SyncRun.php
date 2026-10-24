<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One synchronisation attempt of a connected account: mode, outcome, counts and an actionable error. Never holds tokens
 * or provider payloads — only counts and up to ten moved/cancelled titles for the user's own hub.
 */
class SyncRun extends Model
{
    public const UPDATED_AT = null;

    public const CREATED_AT = null;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['started_at' => 'immutable_datetime', 'finished_at' => 'immutable_datetime', 'details' => 'array'];
    }

    public function finish(string $status, ?string $error = null): void
    {
        $this->forceFill(['status' => $status, 'error' => $error ? mb_substr($error, 0, 500) : null, 'finished_at' => now()])->save();
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return [
            'id' => $this->id, 'mode' => $this->mode, 'status' => $this->status, 'trigger' => $this->trigger,
            'started_at' => $this->started_at->toIso8601String(), 'finished_at' => $this->finished_at?->toIso8601String(),
            'duration_ms' => $this->finished_at ? (int) $this->started_at->diffInMilliseconds($this->finished_at) : null,
            'upserted' => $this->upserted, 'removed' => $this->removed, 'moved' => $this->moved, 'error' => $this->error, 'details' => $this->details ?? (object) [],
        ];
    }
}
