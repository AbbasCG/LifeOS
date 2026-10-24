<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class ScheduleProposal extends Model
{
    use HasFactory;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['items' => 'array', 'warnings' => 'array', 'summary' => 'array', 'starts_on' => 'date:Y-m-d', 'accepted_at' => 'immutable_datetime'];
    }
}
