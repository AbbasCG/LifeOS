<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class OutboundHostRule extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['allow_private' => 'boolean', 'port' => 'integer'];
    }
}
