<?php

namespace Database\Factories;

use App\Models\Habit;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Habit>
 */
class HabitFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->randomElement(['Read 20 pages', 'Meditate 10 minutes', 'Drink water', 'Stretch', 'Journal']), 'recurrence' => 'daily', 'routine' => fake()->randomElement(['morning', 'evening', 'anytime']), 'color' => '#16a34a'];
    }

    public function weekly(): static
    {
        return $this->state(['recurrence' => 'weekly']);
    }
}
