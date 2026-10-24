<?php

namespace App\Models;

use Database\Factories\WeeklyReviewFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class WeeklyReview extends Model
{
    /** @use HasFactory<WeeklyReviewFactory> */
    use HasFactory;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['week_start' => 'date:Y-m-d', 'reflection' => 'array', 'decisions' => 'array', 'priorities' => 'array', 'snapshot' => 'array', 'completed_at' => 'immutable_datetime'];
    }
}
