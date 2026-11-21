<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Completing a recurring task creates the next occurrence as a NEW task: it never inherits the per-user unique identity of the one just
 * completed (tasks.client_id from an offline device, tasks.source_ref from a connected app). Copying them made the insert hit the unique key, so
 * the completion itself failed and rolled back. Everything else about the next occurrence is exactly as before.
 *
 * "Now" is Monday 2027-03-01 10:00 UTC.
 */
class RecurringTaskIdentityTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2027-03-01 10:00', 'UTC'));
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
    }

    private function recurring(array $extra = []): Task
    {
        return Task::create(array_merge([
            'user_id' => $this->user->id, 'title' => 'Water the plants', 'status' => 'todo', 'priority' => 'high', 'recurrence' => 'daily',
            'estimated_minutes' => 15, 'due_at' => CarbonImmutable::parse('2027-03-01 18:00', 'UTC'), 'notes' => 'Balcony first',
            'tags' => ['home'], 'subtasks' => [['title' => 'Fill the can', 'completed' => true]],
        ], $extra));
    }

    private function nextOf(Task $task): ?Task
    {
        return Task::where('user_id', $this->user->id)->whereKeyNot($task->id)->where('title', $task->title)->latest('id')->first();
    }

    public function test_completing_a_recurring_task_created_offline_succeeds_and_the_next_occurrence_has_no_client_id(): void
    {
        $id = $this->postJson('/api/tasks', ['client_id' => $clientId = '3f0e2b8c-6a4f-4f71-9a0e-7f9b2c1d5e10', 'title' => 'Water the plants', 'recurrence' => 'daily', 'due_at' => '2027-03-01T18:00:00Z'])->assertCreated()->json('data.id');

        $this->patchJson("/api/tasks/{$id}", ['status' => 'completed'])->assertOk();

        $done = Task::find($id);
        $this->assertSame(['completed', $clientId], [$done->status, $done->client_id], 'the completed task keeps its own client id');
        $next = $this->nextOf($done);
        $this->assertNotNull($next, 'the next occurrence was created');
        $this->assertNull($next->client_id);
        $this->assertSame('todo', $next->status);
    }

    public function test_an_offline_replay_after_completion_still_returns_the_original_task_and_creates_nothing(): void
    {
        $task = $this->recurring(['client_id' => $clientId = '9d4c1a7e-2b3f-4c5d-8e6f-0a1b2c3d4e5f']);
        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();
        $count = Task::count();

        $replayedId = $this->postJson('/api/tasks', ['client_id' => $clientId, 'title' => 'Water the plants'])->assertOk()->json('data.id');

        $this->assertSame($task->id, $replayedId);
        $this->assertSame($count, Task::count());
    }

    public function test_a_recurring_task_copied_from_a_connected_app_keeps_its_source_and_the_next_occurrence_has_none(): void
    {
        $task = $this->recurring(['source_ref' => 'todoist:123']);

        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();

        $this->assertSame('todoist:123', $task->fresh()->source_ref, 'the copy stays the one linked to the connected item');
        $next = $this->nextOf($task);
        $this->assertNotNull($next);
        $this->assertNull($next->source_ref);
    }

    public function test_the_chain_continues_when_the_next_occurrence_is_completed_too(): void
    {
        $task = $this->recurring(['client_id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'source_ref' => 'google_tasks:abc']);
        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();
        $second = $this->nextOf($task);
        $this->patchJson("/api/tasks/{$second->id}", ['status' => 'completed'])->assertOk();

        $this->assertSame(3, Task::where('title', 'Water the plants')->count());
        $this->assertSame(1, Task::whereNotNull('client_id')->count());
        $this->assertSame(1, Task::whereNotNull('source_ref')->count());
    }

    public function test_completing_through_a_finished_focus_session_succeeds_and_the_session_stays_on_the_completed_task(): void
    {
        $task = $this->recurring(['client_id' => '11111111-2222-4333-8444-555555555555']);
        $session = FocusSession::factory()->create(['user_id' => $this->user->id, 'task_id' => $task->id, 'status' => 'completed', 'kind' => 'focus']);

        $this->postJson("/api/focus-sessions/{$session->id}/complete-task")->assertOk();

        $this->assertSame('completed', $task->fresh()->status);
        $this->assertSame($task->id, $session->fresh()->task_id, 'the focus session is not moved to the next occurrence');
        $this->assertNull($this->nextOf($task)?->client_id);
        $this->assertNotNull($this->nextOf($task));
    }

    public function test_the_next_occurrence_keeps_every_other_field_as_before_and_the_calendar_session_stays_with_the_completed_task(): void
    {
        $task = $this->recurring(['client_id' => '66666666-7777-4888-8999-000000000000', 'source_ref' => 'microsoft_todo:xyz']);
        $block = CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => 'Water the plants', 'kind' => 'flexible', 'starts_at' => '2027-03-01 16:00:00', 'ends_at' => '2027-03-01 16:15:00']);

        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();

        $next = $this->nextOf($task);
        $this->assertSame(
            ['Water the plants', 'high', 'daily', 15, 'Balcony first', ['home'], [['title' => 'Fill the can', 'completed' => false]], 'todo', 0, null, null, null],
            [$next->title, $next->priority, $next->recurrence, $next->estimated_minutes, $next->notes, $next->tags, $next->subtasks, $next->status, $next->actual_minutes, $next->completed_at, $next->scheduled_start, $next->scheduled_end],
        );
        $this->assertTrue($next->due_at->equalTo(CarbonImmutable::parse('2027-03-02 18:00', 'UTC')));
        $this->assertSame($task->id, $block->fresh()->task_id, 'the calendar block stays linked to the completed task');
        $this->assertSame(0, CalendarEvent::where('task_id', $next->id)->count(), 'the next occurrence is not scheduled');
    }

    public function test_a_task_without_recurrence_creates_no_next_occurrence(): void
    {
        $task = $this->recurring(['recurrence' => null, 'client_id' => 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff']);

        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();

        $this->assertSame(1, Task::count());
    }

    public function test_the_model_never_copies_the_identity_columns(): void
    {
        $task = $this->recurring(['client_id' => 'cccccccc-dddd-4eee-8fff-000000000001', 'source_ref' => 'emc:T-1']);

        $next = $task->createNextOccurrence();

        $this->assertSame([null, null], [$next->client_id, $next->source_ref]);
        $this->assertSame([null, null], [$next->fresh()->client_id, $next->fresh()->source_ref]);
    }
}
