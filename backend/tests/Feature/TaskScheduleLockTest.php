<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * PostgreSQL only. A second connection holds SELECT ... FOR UPDATE on the task row inside an open transaction (what a concurrent scheduling request
 * does until it commits). The guarded request on the first connection must wait for that lock: with a short lock_timeout it fails with
 * "lock not available" instead of creating a session, and once the lock is released the same request succeeds.
 *
 * This proves the request really queues on the task row. It is not a stress test of two simultaneous requests (one PHPUnit process cannot run two
 * requests in parallel), and it commits real rows, so it deletes what it created in tearDown instead of using the wrapping transaction.
 */
class TaskScheduleLockTest extends TestCase
{
    use DatabaseTruncation;

    protected function tearDown(): void
    {
        // This test commits for real; leave the shared database as other (transaction-wrapped) tests expect it: empty.
        if (DB::getDriverName() === 'pgsql') {
            CalendarEvent::query()->delete();
            Task::query()->delete();
            User::query()->delete();
        }
        parent::tearDown();
    }

    public function test_a_scheduling_request_waits_for_the_lock_another_connection_holds_on_the_task(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        config(['database.connections.pgsql_other' => config('database.connections.pgsql')]);
        $user = User::factory()->create();
        $task = Task::factory()->create(['user_id' => $user->id]);
        $body = ['starts_at' => '2027-02-03T09:00:00Z', 'ends_at' => '2027-02-03T10:00:00Z'];
        $other = DB::connection('pgsql_other');
        $other->beginTransaction();

        try {
            $other->select('select id from tasks where id = ? for update', [$task->id]);
            DB::statement("set lock_timeout = '400ms'");

            $started = microtime(true);
            $this->actingAs($user)->postJson("/api/tasks/{$task->id}/schedule", $body)->assertStatus(500);
            $this->assertGreaterThanOrEqual(0.35, microtime(true) - $started, 'the request waited for the lock instead of failing at once');
            $this->assertSame(0, CalendarEvent::where('task_id', $task->id)->count(), 'a request that could not take the lock creates nothing');
        } finally {
            $other->rollBack();
            DB::statement('set lock_timeout = 0');
            DB::purge('pgsql_other');
        }

        $this->postJson("/api/tasks/{$task->id}/schedule", $body)->assertCreated();
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
    }
}
