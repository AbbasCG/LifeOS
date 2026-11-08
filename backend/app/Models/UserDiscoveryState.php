<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One person's progress with one announcement, feature, tour or hint. Keys and timestamps only.
 */
class UserDiscoveryState extends Model
{
    public const TYPES = ['release', 'feature', 'tour', 'hint'];

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return [
            'seen_at' => 'immutable_datetime', 'tried_at' => 'immutable_datetime', 'started_at' => 'immutable_datetime', 'completed_at' => 'immutable_datetime',
            'skipped_at' => 'immutable_datetime', 'dismissed_at' => 'immutable_datetime', 'snoozed_until' => 'immutable_datetime', 'notified_at' => 'immutable_datetime',
            'snooze_count' => 'integer', 'step_index' => 'integer', 'helpful' => 'boolean',
        ];
    }

    /** @return array<string, mixed> */
    public function present(): array
    {
        return [
            'type' => $this->subject_type, 'key' => $this->subject_key, 'version' => $this->version,
            'seen_at' => $this->seen_at?->toIso8601String(), 'tried_at' => $this->tried_at?->toIso8601String(),
            'started_at' => $this->started_at?->toIso8601String(), 'completed_at' => $this->completed_at?->toIso8601String(),
            'skipped_at' => $this->skipped_at?->toIso8601String(), 'dismissed_at' => $this->dismissed_at?->toIso8601String(),
            'snoozed_until' => $this->snoozed_until?->toIso8601String(), 'step_index' => (int) $this->step_index, 'helpful' => $this->helpful,
        ];
    }
}
