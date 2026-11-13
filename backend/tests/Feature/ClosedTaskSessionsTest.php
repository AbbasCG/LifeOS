<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * A completed or cancelled task keeps its calendar block (nothing is deleted on the person's behalf) but the block no longer holds the time:
 * finishing a task early frees its later slot. Open tasks, plain events and other people's data behave as before.
 *
 * "Now" is Monday 2027-02-01 08:00 UTC; working hours are the planner defaults (09:00-17:00, Monday to Friday, UTC).
 */
class ClosedTaskSessionsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
    }

    /** @return array{starts_at: string, ends_at: string} */
    private function slot(string $from, string $to, string $day = '2027-02-03'): array
    {
        return ['starts_at' => "{$day}T{$from}:00Z", 'ends_at' => "{$day}T{$to}:00Z"];
    }

    private function booked(string $title, string $from, string $to, string $status = 'todo', ?User $owner = null): Task
    {
        $owner ??= $this->user;
        $task = Task::factory()->create(['user_id' => $owner->id, 'title' => $title, 'status' => $status]);
        CalendarEvent::factory()->create(['user_id' => $owner->id, 'task_id' => $task->id, 'title' => $title, 'kind' => 'task_session', 'starts_at' => "2027-02-03 {$from}:00", 'ends_at' => "2027-02-03 {$to}:00"]);

        return $task;
    }

    public function test_an_open_task_session_still_blocks(): void
    {
        $this->booked('Open', '09:00', '09:30');
        $this->postJson('/api/events', ['title' => 'Clash'] + $this->slot('09:15', '09:45'))->assertUnprocessable();
    }

    public function test_a_completed_tasks_session_no_longer_blocks_but_stays_on_the_calendar(): void
    {
        $task = $this->booked('Done early', '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();

        $this->postJson('/api/events', ['title' => 'Takes the slot'] + $this->slot('09:00', '09:30'))->assertCreated();
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count(), 'the block is not deleted');
    }

    public function test_a_cancelled_tasks_session_no_longer_blocks(): void
    {
        $this->booked('Dropped', '10:00', '10:30', 'cancelled');
        $other = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Other']);
        $this->postJson("/api/tasks/{$other->id}/schedule", $this->slot('10:00', '10:30'))->assertCreated();
    }

    public function test_reopening_the_task_makes_its_block_hold_the_time_again_for_new_bookings(): void
    {
        $task = $this->booked('Maybe done', '11:00', '11:30', 'completed');
        $this->postJson('/api/events', ['title' => 'First'] + $this->slot('11:00', '11:30'))->assertCreated();

        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'todo'])->assertOk();
        $this->postJson('/api/events', ['title' => 'Second'] + $this->slot('11:15', '11:45'))->assertUnprocessable();
    }

    public function test_a_plain_event_of_the_same_user_still_blocks_next_to_a_completed_session(): void
    {
        $this->booked('Done', '13:00', '13:30', 'completed');
        CalendarEvent::factory()->create(['user_id' => $this->user->id, 'title' => 'Dentist', 'kind' => 'fixed', 'starts_at' => '2027-02-03 13:00:00', 'ends_at' => '2027-02-03 13:30:00']);
        $this->postJson('/api/events', ['title' => 'Clash'] + $this->slot('13:00', '13:30'))->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.title', 'Dentist');
    }

    public function test_the_conflict_names_the_open_task_not_the_closed_one_and_the_suggestion_uses_the_freed_slot(): void
    {
        $this->booked('Closed', '09:00', '09:30', 'completed');
        $this->booked('Open', '09:30', '10:00');
        $response = $this->postJson('/api/events', ['title' => 'Wants 09:15'] + $this->slot('09:15', '09:45'))->assertUnprocessable();
        $response->assertJsonCount(1, 'conflict.conflicts')->assertJsonPath('conflict.conflicts.0.title', 'Open');
        $this->assertSame('2027-02-03T10:00:00Z', $response->json('conflict.suggestion.starts_at'));

        $this->postJson('/api/events', ['title' => 'Wants 09:00'] + $this->slot('09:00', '09:30'))->assertCreated();
    }

    public function test_another_users_closed_task_changes_nothing(): void
    {
        $other = User::factory()->create();
        $this->booked('Theirs', '15:00', '15:30', 'completed', $other);
        $this->postJson('/api/events', ['title' => 'Mine'] + $this->slot('15:00', '15:30'))->assertCreated();
    }

    public function test_a_recurring_series_is_not_refused_because_of_a_completed_session(): void
    {
        $this->booked('Done', '09:00', '09:30', 'completed');
        $this->postJson('/api/events', ['title' => 'Daily standup', 'kind' => 'fixed', 'timezone' => 'UTC', 'recurrence' => ['freq' => 'daily', 'interval' => 1]] + $this->slot('09:00', '09:30'))->assertCreated();
    }

    public function test_the_calendar_list_marks_the_blocks_of_closed_tasks(): void
    {
        $this->booked('Done', '09:00', '09:30', 'completed');
        $this->booked('Open', '10:00', '10:30');
        CalendarEvent::factory()->create(['user_id' => $this->user->id, 'title' => 'Plain', 'kind' => 'fixed', 'starts_at' => '2027-02-03 11:00:00', 'ends_at' => '2027-02-03 11:30:00']);

        $items = collect($this->getJson('/api/calendar?from=2027-02-03T00:00:00Z&to=2027-02-04T00:00:00Z')->assertOk()->json('data'))->keyBy('title');
        $this->assertTrue($items['Done']['task_closed']);
        $this->assertFalse($items['Open']['task_closed']);
        $this->assertFalse($items['Plain']['task_closed']);
    }
}
