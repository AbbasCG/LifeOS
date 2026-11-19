<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * PostgreSQL only, same pattern as TaskScheduleLockTest: a second connection holds SELECT ... FOR UPDATE on the task row (what a concurrent write of
 * that task does until it commits). A postpone must queue behind it: with a short lock_timeout it fails without moving anything, and once the lock
 * is released the same request succeeds. It commits real rows, so tearDown removes them.
 */
class TaskPostponeLockTest extends TestCase
{
    use DatabaseTruncation;

    protected function tearDown(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            CalendarEvent::query()->delete();
            Task::query()->delete();
            UserSetting::query()->delete();
            User::query()->delete();
        }
        parent::tearDown();
    }

    public function test_a_postpone_waits_for_the_lock_another_connection_holds_on_the_task(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        $this->travelTo(CarbonImmutable::parse('2026-11-18 11:00', 'UTC'));
        config(['database.connections.pgsql_other' => config('database.connections.pgsql')]);
        $user = User::factory()->create();
        $task = Task::factory()->create(['user_id' => $user->id, 'status' => 'todo', 'due_at' => '2026-11-30 17:00:00']);
        $session = CalendarEvent::create(['user_id' => $user->id, 'task_id' => $task->id, 'title' => $task->title, 'kind' => 'flexible', 'starts_at' => '2026-11-18 14:00:00', 'ends_at' => '2026-11-18 15:00:00']);
        $other = DB::connection('pgsql_other');
        $other->beginTransaction();

        try {
            $other->select('select id from tasks where id = ? for update', [$task->id]);
            DB::statement("set lock_timeout = '400ms'");

            $started = microtime(true);
            $this->actingAs($user)->postJson("/api/tasks/{$task->id}/postpone", ['to' => 'tomorrow'])->assertStatus(500);
            $this->assertGreaterThanOrEqual(0.35, microtime(true) - $started, 'the request waited for the lock instead of failing at once');
            $this->assertSame('2026-11-18 14:00', $session->fresh()->starts_at->format('Y-m-d H:i'), 'a request that could not take the lock moves nothing');
        } finally {
            $other->rollBack();
            DB::statement('set lock_timeout = 0');
            DB::purge('pgsql_other');
        }

        $this->postJson("/api/tasks/{$task->id}/postpone", ['to' => 'tomorrow'])->assertOk();
        $this->assertSame('2026-11-19 09:00', $session->fresh()->starts_at->format('Y-m-d H:i'));
    }
}
