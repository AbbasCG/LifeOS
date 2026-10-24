<?php

namespace Database\Factories;

use App\Models\FocusSession;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<FocusSession>
 */
class FocusSessionFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => $duration = fake()->randomElement([1500, 3000, 5400]), 'elapsed_seconds' => (int) ($duration * fake()->numberBetween(80, 100) / 100), 'completed_at' => now()->subDays(fake()->numberBetween(0, 30))];
    }
}
