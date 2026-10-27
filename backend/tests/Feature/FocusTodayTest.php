<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FocusTodayTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Wednesday 6 January 2027, 15:00 in Amsterdam (14:00 UTC).
        $this->travelTo(CarbonImmutable::parse('2027-01-06 14:00:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
    }

    /** A completed focus session of $minutes that started at $start (UTC). */
    private function completedSession(string $start, int $minutes, string $kind = 'focus'): void
    {
        $at = CarbonImmutable::parse($start, 'UTC');
        FocusSession::create(['user_id' => $this->user->id, 'kind' => $kind, 'status' => 'completed', 'duration_seconds' => $minutes * 60, 'elapsed_seconds' => $minutes * 60, 'started_at' => $at, 'completed_at' => $at->addMinutes($minutes)]);
    }

    public function test_today_shows_minutes_goal_streaks_and_best_hour(): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => ['timezone' => 'Europe/Amsterdam', 'daily_focus_goal' => 60]]);
        $this->completedSession('2027-01-03 08:00:00', 70);   // Sunday 09:00 local, goal met
        $this->completedSession('2027-01-04 08:00:00', 60);   // Monday 09:00 local, goal met
        $this->completedSession('2027-01-05 08:00:00', 30);   // Tuesday: focus day, goal not met
        $this->completedSession('2027-01-05 12:00:00', 40);   // ...goal met in total (70)
        $this->completedSession('2027-01-06 08:00:00', 25);   // today so far
        $this->completedSession('2027-01-06 07:00:00', 10, 'short_break');

        $this->actingAs($this->user)->getJson('/api/focus-sessions/today')->assertOk()->assertExactJson([
            'today_minutes' => 25,
            'goal_minutes' => 60,
            'goal_streak_days' => 3,     // Sun–Tue; today not met yet, so it does not break the streak
            'streak_days' => 4,          // Sun–Wed, any focus counts
            'best_hour' => 9,            // local hour with the most minutes
            'best_hour_minutes' => 185,
        ]);

        // A running session counts towards today: 25 + 40 minutes meets the goal and extends the goal streak.
        FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'running', 'duration_seconds' => 3000, 'elapsed_seconds' => 600, 'resumed_at' => now()->subMinutes(30), 'started_at' => now()->subMinutes(40)]);
        $this->getJson('/api/focus-sessions/today')->assertJsonPath('today_minutes', 65)->assertJsonPath('goal_streak_days', 4);
    }

    public function test_no_goal_no_history_and_a_first_running_session(): void
    {
        $this->actingAs($this->user)->getJson('/api/focus-sessions/today')->assertExactJson([
            'today_minutes' => 0, 'goal_minutes' => null, 'goal_streak_days' => 0, 'streak_days' => 0, 'best_hour' => null, 'best_hour_minutes' => 0,
        ]);
        FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'running', 'duration_seconds' => 1500, 'elapsed_seconds' => 0, 'resumed_at' => now()->subMinutes(5), 'started_at' => now()->subMinutes(5)]);
        $this->getJson('/api/focus-sessions/today')->assertJsonPath('today_minutes', 5)->assertJsonPath('streak_days', 1);
    }

    public function test_the_daily_goal_is_validated_and_only_the_owners_sessions_count(): void
    {
        $other = User::factory()->create();
        FocusSession::create(['user_id' => $other->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 3600, 'elapsed_seconds' => 3600, 'started_at' => now()->subHour(), 'completed_at' => now()]);

        $this->actingAs($this->user)->putJson('/api/settings', ['daily_focus_goal' => 5])->assertUnprocessable()->assertJsonValidationErrors('daily_focus_goal');
        $this->putJson('/api/settings', ['daily_focus_goal' => 90])->assertOk()->assertJsonPath('daily_focus_goal', 90);
        $this->getJson('/api/focus-sessions/today')->assertJsonPath('today_minutes', 0)->assertJsonPath('goal_minutes', 90);
        $this->putJson('/api/settings', ['daily_focus_goal' => null])->assertOk();
        $this->getJson('/api/focus-sessions/today')->assertJsonPath('goal_minutes', null);
        $this->putJson('/api/settings', ['today_layout' => ['phone' => ['order' => ['now', 'focus'], 'hidden' => ['focus']]]])->assertOk();
    }
}
