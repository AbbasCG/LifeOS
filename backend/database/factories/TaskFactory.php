<?php

namespace Database\Factories;

use App\Models\Task;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Task>
 */
class TaskFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->randomElement(['Write proposal', 'Review pull request', 'Prepare slides', 'Call the bank', 'Plan sprint', 'Update budget']).' '.fake()->numberBetween(1, 999), 'status' => 'todo', 'priority' => fake()->randomElement(['low', 'medium', 'high', 'urgent']), 'estimated_minutes' => fake()->randomElement([15, 30, 45, 60, 90, 120]), 'actual_minutes' => 0, 'due_at' => now()->addDays(fake()->numberBetween(1, 21))->setTime(17, 0)];
    }

    public function completed(): static
    {
        return $this->state(fn (array $attributes) => ['status' => 'completed', 'completed_at' => now()->subDays(fake()->numberBetween(0, 14)), 'actual_minutes' => (int) round($attributes['estimated_minutes'] * fake()->numberBetween(70, 140) / 100)]);
    }

    public function overdue(): static
    {
        return $this->state(['status' => 'todo', 'due_at' => now()->subDays(fake()->numberBetween(1, 7))->setTime(17, 0)]);
    }

    public function recurring(string $recurrence = 'daily'): static
    {
        return $this->state(['recurrence' => $recurrence]);
    }
}
