<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class AutomationRun extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['result' => 'array'];
    }
}
