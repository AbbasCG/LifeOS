<?php

namespace Database\Factories;

use App\Models\User;
use App\Models\WeeklyReview;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<WeeklyReview>
 */
class WeeklyReviewFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'week_start' => now()->startOfWeek()->toDateString(),
            'status' => 'draft',
            'reflection' => ['wins' => fake()->sentence(), 'challenges' => '', 'lessons' => '', 'rating' => 4],
            'decisions' => [],
            'priorities' => [],
        ];
    }
}
