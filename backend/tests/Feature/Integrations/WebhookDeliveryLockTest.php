<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\WebhookEndpointService;
use App\Integrations\Webhooks\WebhookHandler;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * PostgreSQL only, with committed data (DatabaseTruncation): while another connection holds a delivery row, as a worker that is running its
 * handlers does, a second run of the same delivery waits for that lock instead of running the handlers a second time.
 */
class WebhookDeliveryLockTest extends TestCase
{
    use DatabaseTruncation;

    protected function tearDown(): void
    {
        // This test commits for real; leave the shared database empty as the transaction-wrapped tests expect it.
        if (DB::getDriverName() === 'pgsql') {
            WebhookDelivery::query()->delete();
            WebhookEndpoint::query()->delete();
        }
        parent::tearDown();
    }

    public function test_a_second_run_waits_for_the_row_lock_another_connection_holds_and_runs_the_handler_only_after_it(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        $runs = new \ArrayObject;
        $this->app->bind('counting.handler', fn () => new class($runs) implements WebhookHandler
        {
            public function __construct(private \ArrayObject $runs) {}

            public function supports(string $providerKey): bool
            {
                return true;
            }

            public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
            {
                $this->runs->append($delivery->delivery_id);
            }
        });
        $this->app->tag('counting.handler', 'integrations.webhook_handlers');
        ['endpoint' => $endpoint] = app(WebhookEndpointService::class)->create('custom', null, 'Lock test', requireEventId: true);
        $delivery = WebhookDelivery::create(['webhook_endpoint_id' => $endpoint->id, 'delivery_id' => 'evt-wait', 'payload_sha256' => hash('sha256', '{}'), 'size' => 2, 'payload' => '{}', 'status' => 'accepted', 'received_at' => now()]);
        config(['database.connections.pgsql_other' => config('database.connections.pgsql')]);
        $other = DB::connection('pgsql_other');
        $other->beginTransaction();

        try {
            $other->select('select id from webhook_deliveries where id = ? for update', [$delivery->id]);
            DB::statement("set lock_timeout = '400ms'");
            $started = microtime(true);
            try {
                (new ProcessWebhookDelivery($delivery->id))->handle();
            } catch (QueryException) {
                // Recording the failed run needs the same row, so it gives up on the same lock timeout.
            }
            $this->assertGreaterThanOrEqual(0.35, microtime(true) - $started, 'the second run waited for the lock instead of running');
            $this->assertSame([], $runs->getArrayCopy(), 'the handler did not run while the row was held');
        } finally {
            $other->rollBack();
            DB::statement('set lock_timeout = 0');
            DB::purge('pgsql_other');
        }

        (new ProcessWebhookDelivery($delivery->id))->handle();
        $this->assertSame(['processed', ['evt-wait']], [$delivery->fresh()->status, $runs->getArrayCopy()]);
    }
}
