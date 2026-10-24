<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\PlanningService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WeeklyPlanningTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(8, 0));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'focus_block_minutes' => 60]]);
        $this->actingAs($this->user);
    }

    public function test_block_splitting_folds_tiny_remainders(): void
    {
        $planner = app(PlanningService::class);

        $this->assertSame([60, 60, 30], $planner->splitIntoBlocks(150, 60));
        $this->assertSame([60, 70], $planner->splitIntoBlocks(130, 60));
        $this->assertSame([10], $planner->splitIntoBlocks(10, 60));
    }

    public function test_weekly_plan_splits_large_tasks_across_days_and_explains_itself(): void
    {
        Task::create(['user_id' => $this->user->id, 'title' => 'Thesis chapter', 'priority' => 'high', 'estimated_minutes' => 240, 'due_at' => '2027-01-08T17:00:00Z']);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 7])->assertCreated()->json();

        $this->assertCount(4, $plan['items']);
        $days = collect($plan['items'])->groupBy(fn ($i) => substr($i['starts_at'], 0, 10));
        $this->assertTrue($days->every(fn ($items) => $items->count() <= PlanningService::MAX_BLOCKS_PER_TASK_PER_DAY));
        $this->assertSame('2027-01-04', $plan['starts_on']);
        $this->assertSame(240, $plan['summary']['totals']['planned_minutes']);
        $this->assertCount(7, $plan['summary']['days']);
        $this->assertStringContainsString('focus block 1 of 4', $plan['items'][0]['explanation']['en']);
        $this->assertStringContainsString('فترة تركيز', $plan['items'][0]['explanation']['ar']);
        $this->assertDatabaseCount('calendar_events', 0);
    }

    public function test_time_already_logged_or_scheduled_is_not_planned_again(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Report', 'estimated_minutes' => 120, 'actual_minutes' => 30]);
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => 'Report', 'kind' => 'flexible', 'starts_at' => '2027-01-05T09:00:00Z', 'ends_at' => '2027-01-05T10:00:00Z']);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 7])->assertCreated()->json();

        $this->assertSame(30, collect($plan['items'])->sum('minutes'));
    }

    public function test_priority_and_focus_window_are_respected(): void
    {
        UserSetting::where('user_id', $this->user->id)->first()->update(['preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'focus_start' => '14:00', 'focus_end' => '16:00']]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Low', 'priority' => 'low', 'estimated_minutes' => 60]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Urgent', 'priority' => 'urgent', 'estimated_minutes' => 60]);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->json();
        $urgent = collect($plan['items'])->firstWhere('title', 'Urgent');

        $this->assertSame('2027-01-04T14:00:00+00:00', $urgent['starts_at']);
        $this->assertContains('focus_window', $urgent['reasons']);
    }

    public function test_overloaded_days_are_detected_with_an_alternative(): void
    {
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T16:30:00Z']);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 2])->json();

        $this->assertTrue($plan['summary']['days'][0]['overloaded']);
        $this->assertFalse($plan['summary']['days'][1]['overloaded']);
        $this->assertSame('2027-01-05', $plan['summary']['overload'][0]['suggested_date']);
    }

    public function test_unschedulable_tasks_get_alternatives(): void
    {
        Task::create(['user_id' => $this->user->id, 'title' => 'Huge', 'estimated_minutes' => 900, 'due_at' => '2027-01-04T17:00:00Z']);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->json();

        $this->assertSame(900, $plan['warnings'][0]['needed_minutes']);
        $this->assertContains('deadline', array_column($plan['warnings'][0]['alternatives'], 'type'));
        $this->assertNotEmpty($plan['warnings'][0]['reason_ar']);
    }

    public function test_user_can_edit_a_proposal_before_accepting_it(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Study', 'estimated_minutes' => 120]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Dentist', 'starts_at' => '2027-01-04T18:00:00Z', 'ends_at' => '2027-01-04T19:00:00Z']);
        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->json();
        $first = $plan['items'][0];

        $this->patchJson("/api/plans/{$plan['id']}", ['items' => [['task_id' => $task->id, 'starts_at' => '2027-01-04T18:30:00Z', 'ends_at' => '2027-01-04T19:30:00Z']]])
            ->assertUnprocessable()->assertJsonValidationErrors('items.0.starts_at');

        $edited = $this->patchJson("/api/plans/{$plan['id']}", ['items' => [
            ['key' => $first['key'], 'task_id' => $task->id, 'starts_at' => $first['starts_at'], 'ends_at' => $first['ends_at']],
            ['task_id' => $task->id, 'starts_at' => '2027-01-04T19:30:00Z', 'ends_at' => '2027-01-04T20:30:00Z'],
        ]])->assertOk()->json();

        $this->assertFalse($edited['items'][0]['manual']);
        $this->assertTrue($edited['items'][1]['manual']);
        $this->assertContains('manual', $edited['items'][1]['reasons']);
        $this->postJson("/api/plans/{$plan['id']}/accept")->assertOk()->assertJsonPath('status', 'accepted');
        $this->assertDatabaseHas('calendar_events', ['task_id' => $task->id, 'starts_at' => '2027-01-04 19:30:00']);
        $this->assertSame(3, CalendarEvent::count());
    }

    public function test_plans_are_private_and_resolved_plans_cannot_be_edited(): void
    {
        $other = User::factory()->create();
        $foreign = ScheduleProposal::create(['user_id' => $other->id, 'items' => [], 'warnings' => []]);
        $this->getJson("/api/plans/{$foreign->id}")->assertNotFound();
        $this->patchJson("/api/plans/{$foreign->id}", ['items' => []])->assertNotFound();
        $this->postJson("/api/plans/{$foreign->id}/accept")->assertNotFound();

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->json();
        $this->postJson("/api/plans/{$plan['id']}/reject")->assertOk();
        $this->patchJson("/api/plans/{$plan['id']}", ['items' => []])->assertUnprocessable();
        $this->getJson('/api/plans')->assertOk()->assertJsonCount(1);
    }

    public function test_missed_blocks_are_detected_and_rescheduled(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Essay', 'estimated_minutes' => 60]);
        $done = Task::create(['user_id' => $this->user->id, 'title' => 'Worked on', 'estimated_minutes' => 60]);
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => 'Essay', 'kind' => 'flexible', 'starts_at' => '2027-01-01T09:00:00Z', 'ends_at' => '2027-01-01T10:00:00Z']);
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $done->id, 'title' => 'Worked on', 'kind' => 'flexible', 'starts_at' => '2027-01-01T11:00:00Z', 'ends_at' => '2027-01-01T12:00:00Z']);
        FocusSession::create(['user_id' => $this->user->id, 'task_id' => $done->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 1500, 'elapsed_seconds' => 1500, 'completed_at' => '2027-01-01T11:30:00Z']);

        $this->getJson('/api/plans/missed')->assertJsonCount(1, 'data')->assertJsonPath('data.0.task_id', $task->id);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1, 'task_ids' => [$task->id]])->json();
        $this->assertCount(1, $plan['items']);
        $this->assertContains('rescheduled', $plan['items'][0]['reasons']);
    }

    public function test_planned_versus_actual(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'estimated_minutes' => 120, 'status' => 'completed', 'completed_at' => '2027-01-05T12:00:00Z']);
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => 'Deep work', 'kind' => 'flexible', 'starts_at' => '2027-01-05T09:00:00Z', 'ends_at' => '2027-01-05T11:00:00Z']);
        FocusSession::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 5400, 'elapsed_seconds' => 5400, 'completed_at' => '2027-01-05T10:30:00Z']);

        $this->getJson('/api/plans/insights?from=2027-01-04&days=7')->assertOk()
            ->assertJsonPath('totals.planned_minutes', 120)
            ->assertJsonPath('totals.actual_minutes', 90)
            ->assertJsonPath('totals.ratio', 0.75)
            ->assertJsonPath('totals.completion_rate', 100)
            ->assertJsonPath('days.1.planned_minutes', 120);
    }

    public function test_weekly_priorities_are_planned_first(): void
    {
        Task::create(['user_id' => $this->user->id, 'title' => 'Urgent', 'priority' => 'urgent', 'estimated_minutes' => 60]);
        $pick = Task::create(['user_id' => $this->user->id, 'title' => 'Chosen', 'priority' => 'low', 'estimated_minutes' => 60]);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1, 'priority_task_ids' => [$pick->id]])->json();

        $this->assertSame('Chosen', $plan['items'][0]['title']);
        $this->assertContains('priority_pick', $plan['items'][0]['reasons']);
    }
}
