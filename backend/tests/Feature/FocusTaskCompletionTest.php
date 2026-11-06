<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Finishing a focus session saves the time and nothing else. A task is completed only when the person confirms it for the task of a
 * session that really finished, and confirming twice (or two requests at once) completes it once.
 */
class FocusTaskCompletionTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-10 09:00', 'UTC'));
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
    }

    private function task(array $extra = []): Task
    {
        return Task::create(['user_id' => $this->user->id, 'title' => 'Write the report', 'status' => 'todo', 'estimated_minutes' => 60] + $extra);
    }

    /** A session on the task, finished after $minutes. */
    private function finished(Task $task, int $minutes = 12): int
    {
        $id = $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'mode' => 'custom', 'duration_seconds' => 3600, 'task_id' => $task->id])->assertCreated()->json('id');
        $this->travel($minutes)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk();

        return $id;
    }

    public function test_finishing_a_session_saves_the_time_and_leaves_the_task_open(): void
    {
        $task = $this->task();
        $this->finished($task);

        $this->assertSame('todo', $task->fresh()->status);
        $this->assertNull($task->fresh()->completed_at);
        $this->assertSame(12, $task->fresh()->actual_minutes);
    }

    public function test_the_session_record_carries_the_status_of_its_task_for_the_page(): void
    {
        $task = $this->task();
        $id = $this->finished($task);

        $this->getJson('/api/focus-sessions')->assertOk()->assertJsonPath('data.0.id', $id)->assertJsonPath('data.0.task.status', 'todo');
    }

    public function test_confirming_completes_the_task_of_a_finished_session(): void
    {
        $task = $this->task();
        $id = $this->finished($task);

        $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertOk()->assertJsonPath('data.id', $task->id)->assertJsonPath('data.status', 'completed');

        $this->assertSame('completed', $task->fresh()->status);
        $this->assertNotNull($task->fresh()->completed_at);
        $this->assertSame(12, $task->fresh()->actual_minutes, 'the time already saved is untouched');
        $openIds = array_column($this->getJson('/api/tasks?due=open&per_page=100')->assertOk()->json('data'), 'id');
        $this->assertNotContains($task->id, $openIds, 'it left the open list');
        $this->assertSame(1, $this->getJson('/api/overview')->assertOk()->json('completed_tasks'));
    }

    public function test_confirming_twice_or_at_once_completes_it_once_and_creates_one_next_occurrence(): void
    {
        $task = $this->task(['recurrence' => 'daily', 'due_at' => now()->addDay()]);
        $id = $this->finished($task);

        $first = $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertOk();
        $completedAt = $task->fresh()->completed_at;
        $this->travel(5)->minutes();
        $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertOk()->assertJsonPath('data.status', 'completed');

        $this->assertEquals($completedAt, $task->fresh()->completed_at, 'the completion time does not move');
        $this->assertSame(2, Task::where('user_id', $this->user->id)->where('title', 'Write the report')->count(), 'the task and exactly one next occurrence');
        $this->assertSame($task->id, $first->json('data.id'));
    }

    public function test_a_session_that_has_not_finished_cannot_complete_its_task(): void
    {
        $task = $this->task();
        $running = $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 3600, 'task_id' => $task->id])->json('id');

        $this->postJson("/api/focus-sessions/{$running}/complete-task")->assertUnprocessable();
        $this->patchJson("/api/focus-sessions/{$running}", ['action' => 'pause']);
        $this->postJson("/api/focus-sessions/{$running}/complete-task")->assertUnprocessable();
        $this->patchJson("/api/focus-sessions/{$running}", ['action' => 'cancel']);
        $this->postJson("/api/focus-sessions/{$running}/complete-task")->assertUnprocessable();

        $this->assertSame('todo', $task->fresh()->status);
    }

    public function test_the_timer_running_out_does_not_complete_the_task_by_itself(): void
    {
        $task = $this->task();
        $id = $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 3600, 'task_id' => $task->id])->json('id');
        $this->travel(60)->minutes();

        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertOk()->assertJsonPath('status', 'completed');

        $this->assertSame('todo', $task->fresh()->status);
    }

    public function test_a_session_without_a_task_and_breaks_complete_nothing(): void
    {
        $other = $this->task(['title' => 'Unrelated']);
        $id = $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 600])->json('id');
        $this->travel(2)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk();

        $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertUnprocessable();
        $this->assertSame('todo', $other->fresh()->status);

        $break = $this->postJson('/api/focus-sessions', ['kind' => 'short_break', 'duration_seconds' => 300])->json('id');
        $this->travel(5)->minutes();
        $this->patchJson("/api/focus-sessions/{$break}", ['action' => 'finish'])->assertOk();
        $this->postJson("/api/focus-sessions/{$break}/complete-task")->assertUnprocessable();
    }

    public function test_another_accounts_session_cannot_be_used_and_a_foreign_task_is_never_touched(): void
    {
        $task = $this->task();
        $id = $this->finished($task);
        $intruder = User::factory()->create();

        $this->actingAs($intruder);
        $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertNotFound();
        $this->assertSame('todo', $task->fresh()->status);
    }

    public function test_an_unknown_or_non_numeric_session_id_is_not_found(): void
    {
        $this->postJson('/api/focus-sessions/99999/complete-task')->assertNotFound();
        $this->postJson('/api/focus-sessions/abc/complete-task')->assertNotFound();
    }

    public function test_a_task_deleted_after_the_session_is_reported_not_crashed(): void
    {
        $task = $this->task();
        $id = $this->finished($task);
        $task->delete();

        $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertUnprocessable();
    }

    public function test_the_session_and_its_saved_time_are_unchanged_by_completing_the_task(): void
    {
        $task = $this->task();
        $id = $this->finished($task, 9);
        $before = FocusSession::find($id)->only(['status', 'elapsed_seconds', 'completed_at', 'duration_seconds']);

        $this->postJson("/api/focus-sessions/{$id}/complete-task")->assertOk();

        $this->assertEquals($before, FocusSession::find($id)->only(['status', 'elapsed_seconds', 'completed_at', 'duration_seconds']));
        $this->assertSame(1, FocusSession::count());
    }
}
