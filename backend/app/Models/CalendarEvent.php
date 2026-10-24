<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class CalendarEvent extends Model
{
    use HasFactory;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['starts_at' => 'immutable_datetime', 'ends_at' => 'immutable_datetime', 'recurrence' => 'array', 'recurrence_until' => 'date:Y-m-d'];
    }

    /** @return HasMany<CalendarEventException, $this> */
    public function exceptions(): HasMany
    {
        return $this->hasMany(CalendarEventException::class);
    }

    public function isRecurring(): bool
    {
        return ! empty($this->recurrence['freq']);
    }
}
