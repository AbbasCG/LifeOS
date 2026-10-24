<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class CalendarEventException extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['original_start' => 'immutable_datetime', 'starts_at' => 'immutable_datetime', 'ends_at' => 'immutable_datetime', 'cancelled' => 'boolean'];
    }

    /** @return BelongsTo<CalendarEvent, $this> */
    public function event(): BelongsTo
    {
        return $this->belongsTo(CalendarEvent::class, 'calendar_event_id');
    }
}
