<?php

namespace Database\Factories;

use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<UserSetting>
 */
class UserSettingFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return ['user_id' => User::factory(), 'preferences' => ['language' => 'en', 'theme' => 'system', 'timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'break_minutes' => 10, 'work_days' => [1, 2, 3, 4, 5]]];
    }
}
