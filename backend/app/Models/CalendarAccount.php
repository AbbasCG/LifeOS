<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class CalendarAccount extends Model
{
    protected $guarded = ['id'];

    /** Tokens never leave the server. */
    protected $hidden = ['access_token', 'refresh_token', 'scopes', 'sync_state'];

    protected function casts(): array
    {
        return ['access_token' => 'encrypted', 'refresh_token' => 'encrypted', 'token_expires_at' => 'immutable_datetime', 'last_synced_at' => 'immutable_datetime', 'collections' => 'array', 'sync_state' => 'array', 'last_attempt_at' => 'immutable_datetime', 'retry_after' => 'immutable_datetime', 'scopes_ok' => 'boolean'];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** @return HasMany<SyncRun, $this> */
    public function runs(): HasMany
    {
        return $this->hasMany(SyncRun::class);
    }

    /** @return HasMany<ExternalTask, $this> */
    public function tasks(): HasMany
    {
        return $this->hasMany(ExternalTask::class);
    }

    /** @return HasMany<ExternalEvent, $this> */
    public function events(): HasMany
    {
        return $this->hasMany(ExternalEvent::class);
    }

    /**
     * Safe representation for the API.
     *
     * @return array<string, mixed>
     */
    public function summary(): array
    {
        return [
            'id' => $this->id,
            'provider' => $this->provider,
            'email' => $this->email,
            'display_name' => $this->display_name,
            'status' => $this->status,
            'last_synced_at' => $this->last_synced_at?->toIso8601String(),
            'last_error' => $this->last_error,
            'events_count' => $this->events_count,
            'collections' => $this->collections ?? [],
            'collections_managed' => $this->collections !== null,
            'last_attempt_at' => $this->last_attempt_at?->toIso8601String(),
            'retry_after' => $this->retry_after?->isFuture() ? $this->retry_after->toIso8601String() : null,
            'consecutive_failures' => $this->consecutive_failures,
            'scopes_ok' => $this->scopes_ok,
            // Which permissions were actually granted, without exposing the raw token response.
            'granted_scopes' => $this->scopes ? array_values(array_filter(preg_split('/[\s,]+/', (string) $this->scopes) ?: [], fn ($s) => $s !== '')) : [],
            'sync_mode' => collect($this->sync_state ?? [])->contains(fn ($s) => ! empty($s['token'])) ? 'incremental' : 'full',
            'connected_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
