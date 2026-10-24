<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class InboxNotification extends Model
{
    use HasFactory;

    protected $guarded = ['id'];

    protected $hidden = ['deduplication_key'];

    protected function casts(): array
    {
        return ['read_at' => 'immutable_datetime', 'pushed_at' => 'immutable_datetime'];
    }
}
