<?php

namespace Database\Factories;

use App\Models\Project;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Project>
 */
class ProjectFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->randomElement(['Website redesign', 'Quarterly report', 'Mobile app', 'Kitchen renovation', 'Conference talk']).' '.fake()->numberBetween(1, 99), 'description' => fake()->sentence(12), 'color' => '#4f46e5', 'status' => 'active', 'due_at' => now()->addDays(fake()->numberBetween(7, 90)), 'milestones' => [['title' => 'Kick-off', 'completed' => true], ['title' => 'First draft', 'completed' => false], ['title' => 'Launch', 'completed' => false]]];
    }
}
