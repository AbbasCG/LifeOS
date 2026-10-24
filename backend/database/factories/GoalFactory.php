<?php

namespace Database\Factories;

use App\Models\Goal;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Goal>
 */
class GoalFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->randomElement(['Read 24 books', 'Run a half marathon', 'Save an emergency fund', 'Learn Spanish']), 'target' => 100, 'progress' => fake()->numberBetween(0, 90), 'due_at' => now()->addMonths(fake()->numberBetween(1, 12)), 'color' => '#16a34a'];
    }
}
