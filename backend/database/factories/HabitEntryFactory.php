<?php

namespace Database\Factories;

use App\Models\Habit;
use App\Models\HabitEntry;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<HabitEntry>
 */
class HabitEntryFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['habit_id' => Habit::factory(), 'date' => now()->subDays(fake()->numberBetween(0, 30))->toDateString()];
    }
}
