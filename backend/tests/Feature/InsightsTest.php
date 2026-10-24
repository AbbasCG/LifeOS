<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class InsightsTest extends TestCase
{
    use RefreshDatabase;

    public function test_guests_cannot_read_insights(): void
    {
        $this->getJson('/api/briefing')->assertUnauthorized();
        $this->getJson('/api/analytics')->assertUnauthorized();
    }

    public function test_briefing_ranks_overdue_and_urgent_work_first(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(10, 0));
        $user = User::factory()->create();
        Task::create(['user_id' => $user->id, 'title' => 'Low someday', 'priority' => 'low']);
        Task::create(['user_id' => $user->id, 'title' => 'Overdue report', 'priority' => 'medium', 'due_at' => '2027-01-03T12:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Urgent call', 'priority' => 'urgent']);
        Task::create(['user_id' => $user->id, 'title' => 'Done', 'status' => 'completed', 'completed_at' => now()]);
        Task::create(['user_id' => User::factory()->create()->id, 'title' => 'Someone else', 'priority' => 'urgent', 'due_at' => '2027-01-01T00:00:00Z']);
        CalendarEvent::create(['user_id' => $user->id, 'title' => 'Standup', 'starts_at' => '2027-01-04T11:00:00Z', 'ends_at' => '2027-01-04T12:00:00Z']);
        FocusSession::create(['user_id' => $user->id, 'kind' => 'manual', 'status' => 'completed', 'duration_seconds' => 1800, 'elapsed_seconds' => 1800, 'completed_at' => '2027-01-04T09:00:00Z']);
        FocusSession::create(['user_id' => $user->id, 'kind' => 'short_break', 'status' => 'completed', 'duration_seconds' => 300, 'elapsed_seconds' => 300, 'completed_at' => '2027-01-04T09:30:00Z']);

        $response = $this->actingAs($user)->getJson('/api/briefing')->assertOk();

        $response->assertJsonPath('focus.0.title', 'Overdue report')
            ->assertJsonPath('focus.0.reasons.0', 'overdue')
            ->assertJsonPath('focus.1.title', 'Urgent call')
            ->assertJsonCount(3, 'focus')
            ->assertJsonPath('stats.completed_today', 1)
            ->assertJsonPath('stats.overdue_tasks', 1)
            ->assertJsonPath('stats.booked_minutes', 60)
            ->assertJsonPath('stats.focus_minutes_today', 30)
            ->assertJsonPath('next_event.title', 'Standup')
            ->assertJsonPath('period', 'morning');
        $this->assertStringNotContainsString('Someone else', $response->getContent());
        $this->assertContains('/tasks?due=overdue', array_column($response->json('suggestions'), 'action'));
    }

    public function test_briefing_reports_habit_streaks_at_risk(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(10, 0));
        $user = User::factory()->create();
        $habit = Habit::create(['user_id' => $user->id, 'title' => 'Read']);
        HabitEntry::create(['habit_id' => $habit->id, 'date' => '2027-01-02']);
        HabitEntry::create(['habit_id' => $habit->id, 'date' => '2027-01-03']);

        $this->actingAs($user)->getJson('/api/briefing')
            ->assertJsonPath('habits.0.current_streak', 2)
            ->assertJsonPath('habits.0.at_risk', true)
            ->assertJsonPath('habits.0.done_today', false);
    }

    public function test_analytics_summarizes_the_period_and_compares_with_the_previous_one(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 14)->setTime(18, 0));
        $user = User::factory()->create();
        $project = Project::create(['user_id' => $user->id, 'title' => 'Thesis']);
        $task = Task::create(['user_id' => $user->id, 'project_id' => $project->id, 'title' => 'Chapter', 'priority' => 'high', 'status' => 'completed', 'estimated_minutes' => 60, 'actual_minutes' => 90, 'due_at' => '2027-01-14T20:00:00Z', 'completed_at' => '2027-01-14T15:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Old', 'status' => 'completed', 'completed_at' => '2027-01-05T09:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Older', 'status' => 'completed', 'completed_at' => '2027-01-04T09:00:00Z']);
        FocusSession::create(['user_id' => $user->id, 'task_id' => $task->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 3000, 'elapsed_seconds' => 3000, 'completed_at' => '2027-01-14T10:50:00Z']);
        FocusSession::create(['user_id' => $user->id, 'kind' => 'short_break', 'status' => 'completed', 'duration_seconds' => 300, 'elapsed_seconds' => 300, 'completed_at' => '2027-01-14T11:00:00Z']);

        $response = $this->actingAs($user)->getJson('/api/analytics?days=7')->assertOk();

        $response->assertJsonPath('range.from', '2027-01-08')
            ->assertJsonPath('totals.completed', 1)
            ->assertJsonPath('totals.focus_minutes', 50)
            ->assertJsonPath('totals.sessions', 1)
            ->assertJsonPath('totals.on_time_rate', 100)
            ->assertJsonPath('totals.estimate_ratio', 1.5)
            ->assertJsonPath('comparison.completed.previous', 2)
            ->assertJsonPath('comparison.completed.change', -50)
            ->assertJsonPath('by_project.0.title', 'Thesis')
            ->assertJsonPath('by_project.0.focus_minutes', 50)
            ->assertJsonPath('focus_by_hour.10.minutes', 50)
            ->assertJsonCount(7, 'series')
            ->assertJsonPath('series.6.completed', 1);
        $this->assertNotEmpty($response->json('insights'));
    }

    public function test_analytics_rejects_unsupported_ranges(): void
    {
        $this->actingAs(User::factory()->create())->getJson('/api/analytics?days=5')->assertUnprocessable();
    }
}
