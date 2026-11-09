<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A copy LifeOS added to a connected calendar was changed at the service as well as in LifeOS, so LifeOS did not push its change. Holds only the LifeOS side
 * (title and times); what is at the service is never read into LifeOS.
 */
class SyncConflict extends Model
{
    public const OPEN = 'open';

    public const RESOLVED = 'resolved';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['local_starts_at' => 'immutable_datetime', 'local_ends_at' => 'immutable_datetime', 'resolved_at' => 'immutable_datetime'];
    }

    /** @return BelongsTo<CalendarAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(CalendarAccount::class, 'calendar_account_id');
    }

    /** @return array<string, mixed> */
    public function present(): array
    {
        return ['id' => $this->id, 'account_id' => $this->calendar_account_id, 'status' => $this->status, 'resolution' => $this->resolution, 'title' => $this->local_title,
            'starts_at' => $this->local_starts_at?->toIso8601String(), 'ends_at' => $this->local_ends_at?->toIso8601String(), 'detected_at' => $this->created_at?->toIso8601String(), 'resolved_at' => $this->resolved_at?->toIso8601String()];
    }
}
