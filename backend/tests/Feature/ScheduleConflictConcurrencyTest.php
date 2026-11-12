<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * PostgreSQL only. Bookings of the SAME user are serialised on the user's row, whichever tasks they are for.
 *
 * A child process (tests/Support/hold_booking.php) boots the application and runs its own CalendarBooking::run for task A: it inserts the event
 * and keeps the transaction open. This process then books a DIFFERENT task B into the same slot through the HTTP API. The child watches, from a
 * third database connection, for a backend blocked on a lock it holds (pg_stat_activity wait_event_type = 'Lock', pg_blocking_pids) and commits only
 * once it has seen B waiting. So nothing here depends on a sleep: B can only finish after A committed, and then it must be refused.
 *
 * The control test runs the same flow with a booking that skips the lock; there the double booking really happens, so the proof above cannot be
 * a test that would pass anyway. These tests commit real rows, so they delete what they created in tearDown.
 */
class ScheduleConflictConcurrencyTest extends TestCase
{
    use DatabaseTruncation;

    private const SLOT = ['starts_at' => '2027-02-03T09:00:00Z', 'ends_at' => '2027-02-03T09:30:00Z'];

    /** @var resource|null */
    private $process = null;

    /** @var array<int, resource> */
    private array $pipes = [];

    protected function tearDown(): void
    {
        if (is_resource($this->process)) {
            proc_terminate($this->process);
            proc_close($this->process);
        }
        if (DB::getDriverName() === 'pgsql') {
            CalendarEvent::query()->delete();
            Task::query()->delete();
            User::query()->delete();
        }
        parent::tearDown();
    }

    private function startHolder(string $mode, User $user, Task $task, int $bound = 60): void
    {
        $command = [PHP_BINARY, base_path('tests/Support/hold_booking.php'), $mode, (string) $user->id, (string) $task->id, self::SLOT['starts_at'], self::SLOT['ends_at'], (string) $bound];
        $env = array_merge(getenv(), ['APP_ENV' => 'testing', 'DB_CONNECTION' => 'pgsql'], array_filter([
            'DB_HOST' => config('database.connections.pgsql.host'), 'DB_PORT' => (string) config('database.connections.pgsql.port'), 'DB_DATABASE' => config('database.connections.pgsql.database'),
            'DB_USERNAME' => config('database.connections.pgsql.username'), 'DB_PASSWORD' => config('database.connections.pgsql.password'),
        ]));
        $this->process = proc_open($command, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', sys_get_temp_dir().'/hold_booking_'.getmypid().'.err', 'w']], $this->pipes, base_path(), $env);
        $this->assertIsResource($this->process, 'the holder process started');
        $this->assertSame("locked\n", $this->readLine(90), 'the holder booked and is holding its transaction open; see '.sys_get_temp_dir().'/hold_booking_'.getmypid().'.err');
    }

    private function readLine(int $seconds): string|false
    {
        $read = [$this->pipes[1]];
        $write = $except = null;

        return stream_select($read, $write, $except, $seconds) ? fgets($this->pipes[1]) : false;
    }

    /** @return list<string> everything the holder printed after "locked" (it has exited by now) */
    private function finishHolder(): array
    {
        $output = stream_get_contents($this->pipes[1]);
        proc_close($this->process);
        $this->process = null;

        return array_values(array_filter(explode("\n", (string) $output)));
    }

    private function book(User $user, Task $task): TestResponse
    {
        return $this->actingAs($user)->postJson("/api/tasks/{$task->id}/schedule", self::SLOT);
    }

    /** @return array{0: User, 1: Task, 2: Task} */
    private function world(): array
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $user = User::factory()->create();

        return [$user, Task::factory()->create(['user_id' => $user->id, 'title' => 'Task A']), Task::factory()->create(['user_id' => $user->id, 'title' => 'Task B'])];
    }

    public function test_a_booking_of_another_task_in_the_same_slot_waits_for_the_first_to_commit_and_is_then_refused(): void
    {
        [$user, $a, $b] = $this->world();
        $this->startHolder('locked', $user, $a);
        $this->assertSame(0, CalendarEvent::count(), 'A is written but not committed: a plain read sees nothing');

        $response = $this->book($user, $b);
        $finishedAt = microtime(true);
        $output = $this->finishHolder();

        $this->assertStringStartsWith('waiter ', $output[0] ?? '', 'a third connection saw the request blocked on a lock before A committed: '.json_encode($output));
        $waiter = json_decode(substr($output[0], 7), true)[0];
        $this->assertSame('Lock', $waiter['wait_event_type']);
        $this->assertStringContainsString('users', $waiter['query'], 'the blocked statement is the user-row lock of the booking');
        $this->assertStringContainsString('for no key update', $waiter['query']);
        $this->assertStringStartsWith('committed ', $output[1] ?? '');
        $this->assertLessThanOrEqual($finishedAt, (float) substr($output[1], 10), 'B only finished after A had committed');

        $response->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict')->assertJsonPath('conflict.conflicts.0.title', 'First booker')
            ->assertJsonPath('conflict.conflicts.0.task_id', $a->id)->assertJsonPath('conflict.suggestion.starts_at', '2027-02-03T09:30:00Z');
        $this->assertSame(1, CalendarEvent::count(), 'exactly one of the two bookings exists');
        $this->assertSame(0, CalendarEvent::where('task_id', $b->id)->count());
    }

    public function test_control_without_the_lock_the_same_flow_double_books(): void
    {
        [$user, $a, $b] = $this->world();
        $this->startHolder('lockfree', $user, $a, 2);

        $response = $this->book($user, $b);
        $this->finishHolder();

        $response->assertCreated();
        $events = CalendarEvent::orderBy('id')->get();
        $this->assertCount(2, $events, 'without the user lock both bookings read "free" and both were written');
        $this->assertTrue($events[0]->starts_at->equalTo($events[1]->starts_at) && $events[0]->ends_at->equalTo($events[1]->ends_at), 'in the very same slot');
    }

    public function test_a_task_lock_followed_by_a_task_insert_does_not_deadlock_with_a_booking(): void
    {
        // AutomationEngine (create_next_occurrence) and WeeklyReviewService::complete lock a task FOR UPDATE and then insert another task, which takes
        // FOR KEY SHARE on the user row. The booking holds the user row and waits for that task. The user lock is FOR NO KEY UPDATE, so the insert is not
        // blocked and the holder finishes; with FOR UPDATE this was a deadlock (SQLSTATE 40P01, HTTP 500).
        [$user, $a] = $this->world();
        $this->startHolder('task-lock', $user, $a);

        $response = $this->book($user, $a);
        $output = $this->finishHolder();

        $this->assertStringStartsWith('waiter ', $output[0] ?? '', 'the booking was blocked on the task lock: '.json_encode($output));
        $this->assertStringStartsWith('committed ', $output[1] ?? '');
        $response->assertCreated();
        $this->assertSame(1, CalendarEvent::count());
        $this->assertSame(1, Task::where('title', 'Next occurrence')->count());
    }
}
