<?php

namespace Database\Factories;

use App\Models\ScheduleProposal;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ScheduleProposal>
 */
class ScheduleProposalFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'status' => 'pending', 'starts_on' => now()->toDateString(), 'days' => 1, 'items' => [], 'warnings' => []];
    }
}
