<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CalendarSchedulingTest extends TestCase
{
    use RefreshDatabase;

    public function test_fixed_commitments_require_confirmation_to_move(): void
    {
        $user = User::factory()->create();
        $fixed = CalendarEvent::create(['user_id' => $user->id, 'title' => 'Exam', 'kind' => 'fixed', 'starts_at' => '2027-02-01T09:00:00Z', 'ends_at' => '2027-02-01T10:00:00Z']);
        $move = ['starts_at' => '2027-02-01T11:00:00Z', 'ends_at' => '2027-02-01T12:00:00Z'];

        $this->actingAs($user)->patchJson("/api/events/{$fixed->id}", $move)->assertUnprocessable()->assertJsonValidationErrors('fixed');
        $this->patchJson("/api/events/{$fixed->id}", ['title' => 'Final exam'])->assertOk();
        $this->patchJson("/api/events/{$fixed->id}", $move + ['confirm_fixed' => true])->assertOk()->assertJsonPath('data.starts_at', '2027-02-01T11:00:00.000000Z');
    }

    public function test_flexible_blocks_move_and_resize_freely_but_never_overlap(): void
    {
        $user = User::factory()->create();
        $flexible = CalendarEvent::create(['user_id' => $user->id, 'title' => 'Writing', 'kind' => 'flexible', 'starts_at' => '2027-02-01T09:00:00Z', 'ends_at' => '2027-02-01T10:00:00Z']);
        CalendarEvent::create(['user_id' => $user->id, 'title' => 'Standup', 'kind' => 'fixed', 'starts_at' => '2027-02-01T11:00:00Z', 'ends_at' => '2027-02-01T11:30:00Z']);

        $this->actingAs($user)->patchJson("/api/events/{$flexible->id}", ['ends_at' => '2027-02-01T10:45:00Z'])->assertOk();
        $this->patchJson("/api/events/{$flexible->id}", ['ends_at' => '2027-02-01T11:15:00Z'])->assertUnprocessable()->assertJsonFragment(['This time conflicts with “Standup” (2027-02-01T11:00:00+00:00 – 2027-02-01T11:30:00+00:00). Choose another time.']);
    }

    public function test_availability_lists_free_slots_inside_working_hours(): void
    {
        $this->travelTo(now()->setDate(2027, 2, 1)->setTime(6, 0));
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5]]]);
        CalendarEvent::create(['user_id' => $user->id, 'title' => 'Meeting', 'starts_at' => '2027-02-01T10:00:00Z', 'ends_at' => '2027-02-01T12:00:00Z']);
        CalendarEvent::create(['user_id' => User::factory()->create()->id, 'title' => 'Other user', 'starts_at' => '2027-02-01T13:00:00Z', 'ends_at' => '2027-02-01T16:00:00Z']);

        $this->actingAs($user)->getJson('/api/availability?date=2027-02-01&days=7')->assertOk()
            ->assertJsonPath('days.0.free_minutes', 360)
            ->assertJsonPath('days.0.slots.0.ends_at', '2027-02-01T10:00:00+00:00')
            ->assertJsonPath('days.0.slots.1.starts_at', '2027-02-01T12:00:00+00:00')
            ->assertJsonPath('days.5.work_day', false)
            ->assertJsonPath('days.5.free_minutes', 0);
    }

    public function test_dashboard_layout_is_validated_and_persisted(): void
    {
        $this->actingAs(User::factory()->create());

        $this->putJson('/api/settings', ['dashboard' => ['order' => ['agenda', 'stats', 'next_moves'], 'hidden' => ['goals']]])->assertOk();
        $this->getJson('/api/settings')->assertJsonPath('dashboard.order.0', 'agenda')->assertJsonPath('dashboard.hidden', ['goals']);
        $this->putJson('/api/settings', ['dashboard' => ['order' => ['stats', 'stats']]])->assertUnprocessable();
        $this->putJson('/api/settings', ['dashboard' => ['order' => ['hacked']]])->assertUnprocessable();
        $this->putJson('/api/settings', ['focus_block_minutes' => 5])->assertUnprocessable();
        $this->putJson('/api/settings', ['focus_block_minutes' => 50, 'daily_focus_limit' => 240])->assertOk()->assertJsonPath('focus_block_minutes', 50);
    }
}
