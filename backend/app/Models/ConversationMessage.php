<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class ConversationMessage extends Model
{
    public const UPDATED_AT = null;

    protected $guarded = ['id'];

    protected $hidden = ['client_id'];

    protected function casts(): array
    {
        return ['payload' => 'array', 'created_at' => 'immutable_datetime'];
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return ['id' => $this->id, 'role' => $this->role, 'content' => $this->content, 'intent' => $this->intent, 'provider' => $this->provider,
            'created_at' => $this->created_at?->toIso8601String()] + ($this->payload ?? []);
    }
}
