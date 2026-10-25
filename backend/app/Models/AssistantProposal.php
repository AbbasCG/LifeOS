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

    /** Applied changes can be undone for this long. */
    public const UNDO_HOURS = 24;

    /** Applied recently, with the before/after state needed to reverse it (proposals applied before undo existed have none). */
    public function canUndo(): bool
    {
        return $this->status === 'applied' && $this->applied_at?->addHours(self::UNDO_HOURS)->isFuture()
            && collect($this->results ?? [])->contains(fn (array $r) => isset($r['after']));
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
            'undo_until' => $this->canUndo() ? $this->applied_at->addHours(self::UNDO_HOURS)->toIso8601String() : null,
        ];
    }
}
