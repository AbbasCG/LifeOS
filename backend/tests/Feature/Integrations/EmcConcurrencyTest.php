<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\WebhookDeliveryQueue;
use App\Integrations\Webhooks\WebhookEndpointService;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\IntegrationLink;
use App\Models\Task;
use App\Models\User;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\DatabaseTruncation;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * PostgreSQL only, with committed data: while another connection holds the person's row (as another EMC event, or any task change of theirs,
 * does), an EMC event for that person waits instead of reading a link or task the other transaction is about to change.
 */
class EmcConcurrencyTest extends TestCase
{
    use DatabaseTruncation;

    protected function tearDown(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            IntegrationLink::query()->delete();
            WebhookDelivery::query()->delete();
            WebhookEndpoint::query()->delete();
            Task::query()->delete();
            User::query()->delete();
        }
        parent::tearDown();
    }

    public function test_an_event_waits_for_the_lock_another_connection_holds_on_the_person_and_then_applies_once(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        $user = User::factory()->create();
        ['endpoint' => $endpoint] = app(WebhookEndpointService::class)->create('emc', $user, 'EMC', requireEventId: true, accountKey: 'default');
        $body = json_encode(['schema_version' => 1, 'event_id' => 'evt-lock', 'type' => 'ticket.assigned', 'occurred_at' => '2026-11-26T10:00:00Z',
            'ticket' => ['external_id' => 'T-9', 'version' => 1, 'title' => 'Locked ticket', 'priority' => 'high']]);
        $delivery = WebhookDelivery::create(['webhook_endpoint_id' => $endpoint->id, 'delivery_id' => 'evt-lock', 'payload_sha256' => hash('sha256', $body), 'size' => strlen($body), 'payload' => $body, 'status' => 'accepted', 'received_at' => now()]);
        config(['database.connections.pgsql_other' => config('database.connections.pgsql')]);
        $other = DB::connection('pgsql_other');
        $other->beginTransaction();

        try {
            $other->select('select id from users where id = ? for no key update', [$user->id]);
            DB::statement("set lock_timeout = '400ms'");
            $started = microtime(true);
            try {
                (new ProcessWebhookDelivery($delivery->id))->handle();
            } catch (QueryException) {
                // Not expected (the delivery row is not the one held), but a refused write here must not fail the test either.
            }
            $this->assertGreaterThanOrEqual(0.35, microtime(true) - $started, 'the event waited for the person\'s lock');
            $this->assertSame([0, 0], [Task::count(), IntegrationLink::count()]);
        } finally {
            $other->rollBack();
            DB::statement('set lock_timeout = 0');
            DB::purge('pgsql_other');
        }

        // Run directly (no queue job) the lock timeout was a final failure: the delivery is failed, with its payload kept.
        $this->assertSame('failed', $delivery->fresh()->status);
        $this->assertTrue(app(WebhookDeliveryQueue::class)->requeue($delivery->fresh()));   // what lifeos:webhooks:retry does; the test queue runs it now
        $this->assertSame(['processed', 1, 1], [$delivery->fresh()->status, Task::count(), IntegrationLink::count()]);
    }
}
