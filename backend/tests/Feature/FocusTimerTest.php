<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
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

    public function test_a_sixty_minute_session_is_not_over_the_moment_it_starts(): void
    {
        // The reported bug: start 60 minutes, and the timer jumps to 00:00 with "60 min saved". Needs no special database.
        $id = $this->start(60);

        $record = $this->getJson('/api/focus-sessions')->assertOk()->json('data.0');
        $this->assertSame('running', $record['status']);
        $this->assertSame(0, $record['elapsed_now_seconds']);
        $this->assertSame(0, $record['overdue_seconds']);

        $this->travel(5)->seconds();
        $this->assertSame(5, $this->getJson('/api/focus-sessions')->json('data.0.elapsed_now_seconds'));
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertUnprocessable();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk()->assertJsonPath('elapsed_seconds', 5);
    }

    public function test_the_database_connection_always_runs_in_utc(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('PostgreSQL only: its session zone decides how a timestamp without an offset is stored.');
        }

        $this->assertSame('UTC', DB::selectOne('show time zone')->TimeZone, 'config/database.php sets the connection zone');
    }

    public function test_elapsed_time_does_not_depend_on_the_time_zone_of_the_database(): void
    {
        // REGRESSION: on a PostgreSQL server set to e.g. Europe/Amsterdam, `resumed_at` (timestamp with time zone) was stored an hour early, so a
        // 60-minute session looked 60 minutes old at once and finished with the full time saved. Simulate that server zone on this connection.
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('PostgreSQL only.');
        }
        DB::statement("set time zone 'Europe/Amsterdam'");

        $id = $this->start(60);
        $this->assertSame(0, $this->getJson('/api/focus-sessions')->json('data.0.elapsed_now_seconds'));
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'auto' => true])->assertUnprocessable();

        $this->travel(7)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'pause'])->assertOk()->assertJsonPath('elapsed_seconds', 420);
        $this->travel(40)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'resume'])->assertOk()->assertJsonPath('elapsed_seconds', 420);
        $this->travel(3)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk()->assertJsonPath('status', 'completed')->assertJsonPath('elapsed_seconds', 600);
    }

    public function test_saving_a_note_does_not_lose_running_time(): void
    {
        $id = $this->start();
        $this->travel(4)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'note', 'notes' => 'Half way'])->assertOk();
        $this->travel(3)->minutes();

        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk()->assertJsonPath('elapsed_seconds', 420);
    }

    public function test_the_database_time_check_is_read_only_and_reports_without_failing(): void
    {
        $this->start();
        $before = FocusSession::count();

        $this->artisan('lifeos:check-database-time')->expectsOutputToContain('Focus sessions checked: 1')->assertSuccessful();

        $this->assertSame($before, FocusSession::count());
    }
}
