<?php

namespace Database\Factories;

use App\Models\CalendarEvent;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<CalendarEvent>
 */
class CalendarEventFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'title' => fake()->randomElement(['Client sync', 'Design critique', 'Dentist', 'Study session', 'Gym']), 'kind' => 'fixed', 'starts_at' => $start = now()->addDays(fake()->numberBetween(1, 14))->setTime(fake()->numberBetween(9, 16), 0), 'ends_at' => $start->copy()->addMinutes(fake()->randomElement([30, 45, 60, 90]))];
    }

    public function flexible(): static
    {
        return $this->state(['kind' => 'flexible']);
    }
}
