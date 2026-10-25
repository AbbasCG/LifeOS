<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A copy of a LifeOS event that LifeOS added to a connected calendar — the only external events LifeOS may change.
 */
class CalendarWriteLink extends Model
{
    protected $guarded = ['id'];

    protected $hidden = ['etag'];

    protected function casts(): array
    {
        return ['starts_at' => 'immutable_datetime', 'ends_at' => 'immutable_datetime'];
    }

    public function account(): BelongsTo
    {
        return $this->belongsTo(CalendarAccount::class, 'calendar_account_id');
    }

    public function event(): BelongsTo
    {
        return $this->belongsTo(CalendarEvent::class, 'calendar_event_id');
    }

    /** Whether the copy still matches its LifeOS event. */
    public function inSync(): bool
    {
        $event = $this->event;

        return $event && $event->title === $this->title && $event->starts_at->equalTo($this->starts_at) && $event->ends_at->equalTo($this->ends_at);
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return ['id' => $this->id, 'account_id' => $this->calendar_account_id, 'event_id' => $this->calendar_event_id, 'title' => $this->title,
            'starts_at' => $this->starts_at->toIso8601String(), 'ends_at' => $this->ends_at->toIso8601String(), 'orphan' => $this->calendar_event_id === null, 'in_sync' => $this->inSync()];
    }
}
