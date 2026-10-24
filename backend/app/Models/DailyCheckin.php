<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class DailyCheckin extends Model
{
    use HasFactory;

    public const SCALES = ['energy', 'mood', 'stress', 'workload'];

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['date' => 'date:Y-m-d', 'energy' => 'integer', 'mood' => 'integer', 'stress' => 'integer', 'workload' => 'integer', 'sleep_minutes' => 'integer'];
    }

    /**
     * @return array<string, mixed>
     */
    public function present(): array
    {
        return ['date' => $this->date->toDateString(), 'energy' => $this->energy, 'mood' => $this->mood, 'stress' => $this->stress, 'workload' => $this->workload, 'sleep_minutes' => $this->sleep_minutes, 'reflection' => $this->reflection, 'updated_at' => $this->updated_at?->toIso8601String()];
    }
}
