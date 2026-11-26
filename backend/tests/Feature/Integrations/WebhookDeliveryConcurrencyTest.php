<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\WebhookDeliveryQueue;
use App\Integrations\Webhooks\WebhookEndpointService;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Queue\TimeoutExceededException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * PostgreSQL only, with two independent processes and committed data. A child process (tests/Support/webhook_row_holder.php) boots the
 * application and holds a webhook delivery row in an open transaction, either while the real job processes it or while the real requeue
 * changes it. This process then writes to the same delivery the way a second worker or operator would. The child watches, from a third
 * connection, for a backend blocked on its lock (pg_stat_activity, pg_blocking_pids) and commits only once it has seen this process waiting,
 * so nothing depends on a sleep: the write here can only run after the child committed, and must then see the committed row.
 */
class WebhookDeliveryConcurrencyTest extends TestCase
{
    use DatabaseTruncation;

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
            WebhookDelivery::query()->delete();
            WebhookEndpoint::query()->delete();
        }
        parent::tearDown();
    }

    public function test_a_timed_out_copy_reporting_failure_waits_for_the_running_copy_and_leaves_its_processed_status(): void
    {
        $delivery = $this->delivery(['status' => 'accepted']);
        $this->startHolder('process', $delivery);

        // The worker gives up on another copy of the job while the first copy is still inside its transaction.
        (new ProcessWebhookDelivery($delivery->id))->failed(new TimeoutExceededException('App\Jobs\ProcessWebhookDelivery has timed out.'));

        $output = $this->finishHolder();
        $this->assertStringStartsWith('waiter ', $output[0], 'this process really waited on the row lock the child held');
        $this->assertSame('committed processed', $output[1]);
        $fresh = $delivery->fresh();
        $this->assertSame(['processed', 1, null, null], [$fresh->status, $fresh->attempts, $fresh->last_error, $fresh->next_attempt_at]);
        $this->assertNull($fresh->payload);
    }

    public function test_a_late_failure_from_an_earlier_generation_waits_for_a_concurrent_requeue_and_then_writes_nothing(): void
    {
        // A retrying delivery whose job was lost: an operator requeues it while the old job's failed() hook finally runs.
        $delivery = $this->delivery(['status' => 'retrying', 'attempts' => 2, 'next_attempt_at' => now()->subHours(2), 'received_at' => now()->subHours(3)]);
        $this->startHolder('requeue', $delivery);

        (new ProcessWebhookDelivery($delivery->id))->failed(new TimeoutExceededException('App\Jobs\ProcessWebhookDelivery has timed out.'));

        $output = $this->finishHolder();
        $this->assertStringStartsWith('waiter ', $output[0]);
        $this->assertSame('committed requeued', $output[1]);
        $fresh = $delivery->fresh();
        // Without the generation check the old job would have matched the runnable "accepted" row and marked the new attempt failed.
        $this->assertSame(['accepted', 1, 2, null, null], [$fresh->status, $fresh->processing_generation, $fresh->attempts, $fresh->last_error, $fresh->processed_at]);

        // The job of the new generation is the one that may still record a failure.
        (new ProcessWebhookDelivery($delivery->id, 1))->failed(null);
        $this->assertSame(['failed', 3, 'The queue worker stopped the job.'], [$delivery->fresh()->status, $delivery->fresh()->attempts, $delivery->fresh()->last_error]);
    }

    public function test_two_operators_on_independent_connections_requeue_a_failed_delivery_once(): void
    {
        $delivery = $this->delivery(['status' => 'failed', 'attempts' => 1, 'processed_at' => now(), 'last_error' => 'RuntimeException']);
        $staleCopy = WebhookDelivery::with('endpoint')->findOrFail($delivery->id);   // read before either requeue, as both operators did
        Queue::fake();
        $this->startHolder('requeue', $delivery);

        $second = app(WebhookDeliveryQueue::class)->requeue($staleCopy);

        $output = $this->finishHolder();
        $this->assertStringStartsWith('waiter ', $output[0]);
        $this->assertSame('committed requeued', $output[1]);
        $this->assertFalse($second, 'the second requeue saw the committed row and changed nothing');
        Queue::assertNothingPushed();
        $this->assertSame(['accepted', 1], [$delivery->fresh()->status, $delivery->fresh()->processing_generation]);
    }

    /** @param  array<string, mixed>  $attributes */
    private function delivery(array $attributes): WebhookDelivery
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks across connections are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        ['endpoint' => $endpoint] = app(WebhookEndpointService::class)->create('custom', null, 'Concurrency test', requireEventId: true);

        return WebhookDelivery::create(array_merge([
            'webhook_endpoint_id' => $endpoint->id, 'delivery_id' => 'evt-race', 'payload_sha256' => hash('sha256', '{}'), 'size' => 2, 'payload' => '{}',
            'received_at' => now(),
        ], $attributes))->fresh();
    }

    private function startHolder(string $mode, WebhookDelivery $delivery, int $bound = 60): void
    {
        $command = [PHP_BINARY, base_path('tests/Support/webhook_row_holder.php'), $mode, (string) $delivery->id, (string) $bound];
        $env = array_merge(getenv(), ['APP_ENV' => 'testing', 'DB_CONNECTION' => 'pgsql'], array_filter([
            'DB_HOST' => config('database.connections.pgsql.host'), 'DB_PORT' => (string) config('database.connections.pgsql.port'), 'DB_DATABASE' => config('database.connections.pgsql.database'),
            'DB_USERNAME' => config('database.connections.pgsql.username'), 'DB_PASSWORD' => config('database.connections.pgsql.password'),
        ]));
        $log = sys_get_temp_dir().'/webhook_row_holder_'.getmypid().'.err';
        $this->process = proc_open($command, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', $log, 'w']], $this->pipes, base_path(), $env);
        $this->assertIsResource($this->process, 'the holder process started');
        $this->assertSame("locked\n", $this->readLine(90), "the holder is holding the delivery row in an open transaction; see {$log}");
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
}
