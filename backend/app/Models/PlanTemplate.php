<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class PlanTemplate extends Model
{
    public const MAX_BLOCKS = 30;

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['blocks' => 'array'];
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return ['id' => $this->id, 'name' => $this->name, 'blocks' => $this->blocks, 'minutes' => (int) collect($this->blocks)->sum('minutes'),
            'days' => collect($this->blocks)->pluck('weekday')->unique()->count(), 'updated_at' => $this->updated_at?->toIso8601String()];
    }
}
