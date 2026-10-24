<?php

namespace Database\Factories;

use App\Models\InboxNotification;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<InboxNotification>
 */
class InboxNotificationFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->sentence(5), 'kind' => 'info', 'category' => fake()->randomElement(['reminders', 'deadlines', 'calendar', 'planning']), 'link' => '/tasks', 'deduplication_key' => 'factory:'.fake()->uuid()];
    }
}
