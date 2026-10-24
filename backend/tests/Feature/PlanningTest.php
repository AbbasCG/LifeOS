<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PlanningTest extends TestCase
{
    use RefreshDatabase;

    public function test_proposals_preserve_events_and_require_explicit_acceptance(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(8, 0));
        $user = User::factory()->create();
        $this->actingAs($user);
        Task::create(['user_id' => $user->id, 'title' => 'Study', 'estimated_minutes' => 90, 'due_at' => '2027-01-04T18:00:00Z']);
        CalendarEvent::create(['user_id' => $user->id, 'title' => 'Fixed', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T10:00:00Z']);
        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->assertCreated()->assertJsonPath('status', 'pending')->json();
        $this->assertCount(2, $plan['items']);
        $this->assertDatabaseCount('calendar_events', 1);
        $this->postJson('/api/plans/'.$plan['id'].'/accept')->assertOk();
        $this->assertDatabaseCount('calendar_events', 3);
        $this->postJson('/api/plans/'.$plan['id'].'/accept')->assertUnprocessable();
    }

    public function test_stale_calendar_prevents_entire_acceptance(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(8, 0));
        $user = User::factory()->create();
        $this->actingAs($user);
        Task::create(['user_id' => $user->id, 'title' => 'Study', 'estimated_minutes' => 30]);
        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->assertCreated()->assertJsonPath('status', 'pending')->json();
        CalendarEvent::create(['user_id' => $user->id, 'title' => 'New meeting', 'starts_at' => $plan['items'][0]['starts_at'], 'ends_at' => $plan['items'][0]['ends_at']]);
        $this->postJson('/api/plans/'.$plan['id'].'/accept')->assertUnprocessable();
        $this->assertDatabaseCount('calendar_events', 1);
    }

    public function test_insufficient_availability_leaves_task_unscheduled(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(8, 0));
        $user = User::factory()->create();
        $this->actingAs($user);
        Task::create(['user_id' => $user->id, 'title' => 'Large task', 'estimated_minutes' => 600]);
        $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->assertCreated()->assertJsonCount(0, 'items')->assertJsonCount(1, 'warnings');
    }
}
