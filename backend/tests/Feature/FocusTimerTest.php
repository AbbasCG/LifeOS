<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * The focus timer's rules, with the clock moved by hand: a session counts only the time that really passed, is finished
 * automatically only once its planned time is really up, is never duplicated, and never completes the task it is linked to.
 */
class FocusTimerTest extends TestCase
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

    private function start(int $minutes = 25, array $extra = []): int
    {
        return $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'mode' => 'pomodoro', 'duration_seconds' => $minutes * 60, 'cycle' => 1] + $extra)->assertCreated()->json('id');
    }

    public function test_starting_a_pomodoro_counts_down_and_records_nothing_yet(): void
    {
        $id = $this->start();

        $this->getJson('/api/focus-sessions')->assertOk()->assertJsonPath('data.0.status', 'running')->assertJsonPath('data.0.elapsed_seconds', 0)->assertJsonPath('data.0.duration_seconds', 1500);
        $this->assertNull(FocusSession::find($id)->completed_at);
        $this->assertSame(0, (int) $this->getJson('/api/focus-sessions/insights?days=7')->json('minutes'));
    }

    public function test_finishing_early_records_only_the_time_that_really_passed(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Write', 'actual_minutes' => 0, 'status' => 'todo']);
        $id = $this->start(25, ['task_id' => $task->id]);

        $this->travel(7)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk()
            ->assertJsonPath('status', 'completed')->assertJsonPath('elapsed_seconds', 420)->assertJsonPath('duration_seconds', 1500);

        $this->assertSame(7, $task->fresh()->actual_minutes, 'the planned 25 minutes are not credited');
        $this->assertSame('todo', $task->fresh()->status, 'time spent never completes the task');
    }

    public function test_an_automatic_finish_before_the_time_is_up_is_refused_and_changes_nothing(): void
    {
        $id = $this->start();
        $this->travel(2)->seconds();

        // The page believes the countdown reached zero (wrong device clock, a stale tab); the server's clock says otherwise.
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertUnprocessable();

        $session = FocusSession::find($id);
        $this->assertSame('running', $session->status);
        $this->assertNull($session->completed_at);
        $this->assertSame(0, $session->elapsed_seconds);
        $this->assertSame(1, FocusSession::count());
    }

    public function test_an_automatic_finish_once_the_planned_time_is_really_up_completes_the_session(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Write', 'actual_minutes' => 0, 'status' => 'todo']);
        $id = $this->start(25, ['task_id' => $task->id]);

        $this->travel(25)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertOk()->assertJsonPath('status', 'completed')->assertJsonPath('elapsed_seconds', 1500);
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertOk();

        $this->assertSame(25, $task->fresh()->actual_minutes, 'a repeated finish counts once');
        $this->assertSame('todo', $task->fresh()->status);
    }

    public function test_an_automatic_finish_allows_a_couple_of_seconds_of_clock_rounding(): void
    {
        $id = $this->start();
        $this->travel(1499)->seconds();

        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertOk()->assertJsonPath('status', 'completed');
    }

    public function test_pause_stops_the_clock_and_resume_continues_it(): void
    {
        $id = $this->start();
        $this->travel(5)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'pause'])->assertOk()->assertJsonPath('status', 'paused')->assertJsonPath('elapsed_seconds', 300);
        $this->travel(40)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'resume'])->assertOk()->assertJsonPath('status', 'running')->assertJsonPath('elapsed_seconds', 300);
        $this->travel(3)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk()->assertJsonPath('elapsed_seconds', 480);
    }

    public function test_listing_sessions_never_changes_them_even_when_one_was_abandoned(): void
    {
        $id = $this->start();
        $this->travel(3)->hours();

        $listed = $this->getJson('/api/focus-sessions')->assertOk()->json('data.0');

        $this->assertSame('running', $listed['status'], 'reading is not a decision to finish');
        $this->assertSame(0, FocusSession::find($id)->elapsed_seconds);
        $this->assertNull(FocusSession::find($id)->completed_at);
    }

    public function test_a_retried_start_returns_the_same_session_and_a_second_start_is_refused(): void
    {
        $key = (string) Str::uuid();
        $first = $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 1500, 'client_id' => $key])->assertCreated();
        $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 1500, 'client_id' => $key])->assertOk()->assertJsonPath('id', $first->json('id'));
        $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 1500, 'client_id' => (string) Str::uuid()])->assertUnprocessable()->assertJsonValidationErrors('session');

        $this->assertSame(1, FocusSession::count(), 'no duplicate rows');
    }

    public function test_a_task_session_belongs_to_that_task_only_and_another_account_cannot_use_it(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Mine', 'estimated_minutes' => 60]);
        $theirs = Task::create(['user_id' => User::factory()->create()->id, 'title' => 'Theirs']);

        $this->postJson('/api/focus-sessions', ['kind' => 'focus', 'duration_seconds' => 3600, 'task_id' => $theirs->id])->assertUnprocessable();
        $this->assertSame(0, FocusSession::count());
        $id = $this->start(60, ['task_id' => $task->id]);
        $this->assertSame($task->id, FocusSession::find($id)->task_id);
        $this->assertSame(3600, FocusSession::find($id)->duration_seconds);
    }

    public function test_logging_time_that_overlaps_says_how_long_an_entry_can_be_and_changes_no_record(): void
    {
        $id = $this->start(25);
        $this->travel(20)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk();
        $before = FocusSession::find($id)->only(['status', 'elapsed_seconds', 'completed_at']);
        $this->travel(5)->minutes();

        $response = $this->postJson('/api/focus-sessions', ['kind' => 'manual', 'duration_seconds' => 1800])->assertUnprocessable();
        $this->assertStringContainsString('5 minutes', $response->json('errors.duration_seconds.0'));
        $this->assertSame(1, FocusSession::count());
        $this->assertEquals($before, FocusSession::find($id)->only(['status', 'elapsed_seconds', 'completed_at']));

        $this->postJson('/api/focus-sessions', ['kind' => 'manual', 'duration_seconds' => 300])->assertCreated();
        $this->assertSame(2, FocusSession::count());
    }
}
