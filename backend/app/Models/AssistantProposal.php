<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class AssistantProposal extends Model
{
    use HasUuids;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['explanation' => 'array', 'actions' => 'array', 'results' => 'array', 'expires_at' => 'immutable_datetime', 'applied_at' => 'immutable_datetime'];
    }

    public function isOpen(): bool
    {
        return $this->status === 'pending' && $this->expires_at->isFuture();
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return [
            'id' => $this->id, 'kind' => $this->kind, 'provider' => $this->provider, 'status' => $this->isOpen() || $this->status !== 'pending' ? $this->status : 'expired',
            'summary' => $this->summary, 'explanation' => $this->explanation, 'actions' => $this->actions, 'results' => $this->results,
            'expires_at' => $this->expires_at->toIso8601String(), 'applied_at' => $this->applied_at?->toIso8601String(),
        ];
    }
}
