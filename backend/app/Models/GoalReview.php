<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A goal's state at a monthly review (V18): how far along it was and what happened in that month.
 */
class GoalReview extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['period_start' => 'immutable_date', 'period_end' => 'immutable_date', 'percent' => 'integer', 'tasks_done' => 'integer', 'focus_minutes' => 'integer'];
    }
}
