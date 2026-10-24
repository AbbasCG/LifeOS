<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A read-only task imported from a connected app. LifeOS never changes it at the source.
 */
class ExternalTask extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['due_at' => 'immutable_datetime', 'due_is_date' => 'boolean'];
    }

    /** @return BelongsTo<CalendarAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(CalendarAccount::class, 'calendar_account_id');
    }

    /** Reference stored on a LifeOS task copied from this one, used to prevent duplicates. */
    public function sourceRef(string $provider): string
    {
        return $provider.':'.$this->external_id;
    }
}
