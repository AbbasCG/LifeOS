<?php

namespace Tests\Feature;

use App\Models\Habit;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * "Today" is the user's day in their own timezone, not the server's (UTC). Around midnight the two differ by a day,
 * and a date the browser sends as "today" must be accepted or refused by the user's clock.
 */
class UserDayTest extends TestCase
{
    use RefreshDatabase;

    private function userIn(string $timezone): User
    {
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['timezone' => $timezone]]);

        return $user;
    }

    private function habit(User $user): Habit
    {
        return Habit::create(['user_id' => $user->id, 'title' => 'Read', 'recurrence' => 'daily']);
    }

    public function test_a_habit_can_be_logged_for_the_local_today_when_the_local_day_is_ahead_of_utc(): void
    {
        // 23:30 UTC on 6 January is already 12:30 on 7 January in Auckland.
        $this->travelTo(CarbonImmutable::parse('2027-01-06 23:30:00', 'UTC'));
        $user = $this->userIn('Pacific/Auckland');
        $habit = $this->habit($user);

        $this->actingAs($user)->putJson("/api/habits/{$habit->id}/entry", ['date' => '2027-01-07', 'completed' => true])->assertOk();
        $this->assertDatabaseHas('habit_entries', ['habit_id' => $habit->id, 'date' => '2027-01-07']);
        // Tomorrow, on the user's clock, is still the future.
        $this->putJson("/api/habits/{$habit->id}/entry", ['date' => '2027-01-08', 'completed' => true])->assertUnprocessable()->assertJsonValidationErrors('date');
    }

    public function test_a_habit_cannot_be_logged_for_a_day_that_has_not_started_where_the_user_is(): void
    {
        // 03:00 UTC on 6 January is still the evening of 5 January in Los Angeles.
        $this->travelTo(CarbonImmutable::parse('2027-01-06 03:00:00', 'UTC'));
        $user = $this->userIn('America/Los_Angeles');
        $habit = $this->habit($user);

        $this->actingAs($user)->putJson("/api/habits/{$habit->id}/entry", ['date' => '2027-01-06', 'completed' => true])->assertUnprocessable()->assertJsonValidationErrors('date');
        $this->putJson("/api/habits/{$habit->id}/entry", ['date' => '2027-01-05', 'completed' => true])->assertOk();
    }

    public function test_the_day_plan_follows_the_users_day_around_midnight(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-01-06 23:30:00', 'UTC'));
        $user = $this->userIn('Pacific/Auckland');

        // Auckland's today is the 7th: the 6th is already past, the 7th is accepted.
        $this->actingAs($user)->getJson('/api/day-plan?date=2027-01-06')->assertUnprocessable()->assertJsonValidationErrors('date');
        $this->getJson('/api/day-plan?date=2027-01-07')->assertOk()->assertJsonPath('date', '2027-01-07');
        $this->getJson('/api/day-plan')->assertOk()->assertJsonPath('date', '2027-01-07');
    }

    public function test_the_signed_in_user_carries_the_timezone_the_app_uses_for_today(): void
    {
        $user = $this->userIn('Europe/Amsterdam');

        $this->actingAs($user)->getJson('/api/user')->assertOk()->assertJsonPath('timezone', 'Europe/Amsterdam')->assertJsonPath('id', $user->id);
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('timezone', 'Europe/Amsterdam');
        // A user who never chose a zone is planned in UTC, and says so.
        $this->actingAs(User::factory()->create())->getJson('/api/user')->assertOk()->assertJsonPath('timezone', 'UTC');
    }
}
