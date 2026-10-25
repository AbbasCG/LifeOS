<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A proactive suggestion derived from the user's own data. Never an action by itself: acting on one creates a
 * proposal the user still approves.
 */
class Recommendation extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['payload' => 'array', 'feedback_at' => 'immutable_datetime', 'dismissed_at' => 'immutable_datetime', 'snoozed_until' => 'immutable_datetime',
            'acted_at' => 'immutable_datetime', 'first_seen_at' => 'immutable_datetime', 'last_seen_at' => 'immutable_datetime'];
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return ['id' => $this->id, 'type' => $this->type, 'severity' => $this->severity, 'status' => $this->status, 'feedback' => $this->feedback,
            'proposal_id' => $this->proposal_id, 'first_seen_at' => $this->first_seen_at->toIso8601String(), 'snoozed_until' => $this->snoozed_until?->toIso8601String()] + $this->payload;
    }
}
