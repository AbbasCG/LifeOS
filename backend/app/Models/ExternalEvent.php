<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ExternalEvent extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['starts_at' => 'immutable_datetime', 'ends_at' => 'immutable_datetime', 'all_day' => 'boolean', 'original_start' => 'immutable_datetime', 'previous_starts_at' => 'immutable_datetime', 'changed_at' => 'immutable_datetime'];
    }

    /** @return BelongsTo<CalendarAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(CalendarAccount::class, 'calendar_account_id');
    }
}
