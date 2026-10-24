<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Task extends Model
{
    use HasFactory;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['due_at' => 'immutable_datetime', 'scheduled_start' => 'immutable_datetime', 'scheduled_end' => 'immutable_datetime', 'completed_at' => 'immutable_datetime', 'subtasks' => 'array', 'tags' => 'array'];
    }
}
