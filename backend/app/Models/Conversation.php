<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Conversation extends Model
{
    use HasUuids;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['last_message_at' => 'immutable_datetime'];
    }

    public function messages(): HasMany
    {
        return $this->hasMany(ConversationMessage::class)->orderBy('id');
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return ['id' => $this->id, 'title' => $this->title, 'language' => $this->language, 'last_message_at' => $this->last_message_at->toIso8601String(), 'created_at' => $this->created_at?->toIso8601String()];
    }
}
