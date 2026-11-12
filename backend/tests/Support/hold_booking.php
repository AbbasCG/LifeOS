<?php

/**
 * Child process of ScheduleConflictConcurrencyTest (PostgreSQL). It boots the real application and holds one booking open, so the test can start a
 * second booking through the HTTP API in the parent process and watch it wait.
 *
 * Usage: php hold_booking.php <mode> <user id> <task id> <starts_at> <ends_at>
 *   locked     the app's own CalendarBooking::run: user lock, task lock, overlap check, insert; stays open until a waiter is seen, then commits.
 *   lockfree   control: the same check and insert in a plain transaction WITHOUT the booking lock.
 *   task-lock  what AutomationEngine / WeeklyReviewService do: lock the task row FOR UPDATE, then insert a task row (FK to the user).
 *
 * stdout lines: `locked`, `waiter <json>` (a backend blocked on a lock held by this transaction, seen from a THIRD connection), `committed <unix time>`.
 * The only waiting is on a database lock, with an upper bound of $argv[6] seconds (default 60) in case no waiter ever shows up.
 */

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use App\Services\CalendarBooking;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

$base = dirname(__DIR__, 2);
require $base.'/vendor/autoload.php';
$app = require $base.'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

[, $mode, $userId, $taskId, $startsAt, $endsAt] = $argv;
$bound = (int) ($argv[6] ?? 60);
config(['database.connections.monitor' => config('database.connections.pgsql')]);

$say = function (string $line): void {
    fwrite(STDOUT, $line."\n");
    fflush(STDOUT);
};

$waitForWaiter = function () use ($bound, $say): void {
    $holder = (int) DB::selectOne('select pg_backend_pid() as pid')->pid;
    $deadline = microtime(true) + $bound;
    while (microtime(true) < $deadline) {
        $rows = DB::connection('monitor')->select("select pid, wait_event_type, wait_event, state, query from pg_stat_activity where wait_event_type = 'Lock' and ? = any (pg_blocking_pids(pid))", [$holder]);
        if ($rows) {
            $say('waiter '.json_encode($rows));

            return;
        }
        usleep(20000);
    }
};

$user = User::findOrFail((int) $userId);
$start = CarbonImmutable::parse($startsAt);
$end = CarbonImmutable::parse($endsAt);
$book = function () use ($user, $taskId, $start, $end, $say, $waitForWaiter): void {
    app(CalendarBooking::class)->assertFree($user, $start, $end);
    CalendarEvent::create(['user_id' => $user->id, 'task_id' => (int) $taskId, 'title' => 'First booker', 'kind' => 'flexible', 'starts_at' => $start, 'ends_at' => $end]);
    $say('locked');
    $waitForWaiter();
};

match ($mode) {
    'locked' => app(CalendarBooking::class)->run($user, [(int) $taskId], $book),
    'lockfree' => DB::transaction($book),
    'task-lock' => DB::transaction(function () use ($user, $taskId, $say, $waitForWaiter) {
        Task::where('user_id', $user->id)->whereKey((int) $taskId)->lockForUpdate()->firstOrFail();
        $say('locked');
        $waitForWaiter();
        Task::create(['user_id' => $user->id, 'title' => 'Next occurrence', 'status' => 'todo', 'priority' => 'medium']);
    }),
};
$say('committed '.sprintf('%.6f', microtime(true)));
