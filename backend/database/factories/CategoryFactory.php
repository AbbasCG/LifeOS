<?php

namespace Database\Factories;

use App\Models\Category;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Category>
 */
class CategoryFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->randomElement(['Work', 'Study', 'Health', 'Personal', 'Finance']), 'color' => fake()->randomElement(['#4f46e5', '#0ea5e9', '#16a34a', '#f59e0b', '#db2777'])];
    }
}
