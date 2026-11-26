<?php

/**
 * Child process of WebhookDeliveryConcurrencyTest (PostgreSQL). It boots the real application on its own database connection and holds one
 * webhook delivery row locked in an open transaction, so the test can run a second job (or operator) in the parent process and watch it wait.
 *
 * Usage: php webhook_row_holder.php <mode> <delivery id> [bound seconds]
 *   process  the app's own ProcessWebhookDelivery::handle() with a handler that waits for a waiter: commits the delivery as "processed".
 *   requeue  locks the row, waits for a waiter, then runs the app's own WebhookDeliveryQueue::requeue() in the same transaction and commits
 *            (generation + 1, status "accepted"), as a second operator or a redelivery would.
 *
 * stdout lines: `locked`, `waiter <json>` (a backend blocked on a lock held by this transaction, seen from a THIRD connection), `committed <result>`.
 * The only waiting is on a database lock, with an upper bound of $argv[3] seconds (default 60) in case no waiter ever shows up.
 */

use App\Integrations\Webhooks\WebhookDeliveryQueue;
use App\Integrations\Webhooks\WebhookHandler;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

$base = dirname(__DIR__, 2);
require $base.'/vendor/autoload.php';
$app = require $base.'/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

[, $mode, $deliveryId] = $argv;
$bound = (int) ($argv[3] ?? 60);
config(['database.connections.monitor' => config('database.connections.pgsql'), 'queue.default' => 'null']);   // the requeued job is not run here

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

$app->instance('holder.handler', new class($say, $waitForWaiter) implements WebhookHandler
{
    public function __construct(private Closure $say, private Closure $waitForWaiter) {}

    public function supports(string $providerKey): bool
    {
        return true;
    }

    public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
    {
        ($this->say)('locked');
        ($this->waitForWaiter)();
    }
});
$app->tag('holder.handler', 'integrations.webhook_handlers');

$result = match ($mode) {
    'process' => (function () use ($deliveryId) {
        (new ProcessWebhookDelivery((int) $deliveryId))->handle();

        return WebhookDelivery::findOrFail((int) $deliveryId)->status;
    })(),
    'requeue' => DB::transaction(function () use ($deliveryId, $say, $waitForWaiter) {
        $delivery = WebhookDelivery::with('endpoint')->whereKey((int) $deliveryId)->lockForUpdate()->firstOrFail();
        $say('locked');
        $waitForWaiter();

        return app(WebhookDeliveryQueue::class)->requeue($delivery) ? 'requeued' : 'refused';
    }),
};
$say('committed '.$result);
