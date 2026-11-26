<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\PermanentWebhookException;
use App\Integrations\Webhooks\WebhookDeliveryQueue;
use App\Integrations\Webhooks\WebhookEndpointService;
use App\Integrations\Webhooks\WebhookHandler;
use App\Integrations\Webhooks\WebhookVerifier;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\Task;
use App\Models\User;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Queue\TimeoutExceededException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Exceptions;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Queue;
use RuntimeException;
use Tests\TestCase;

/**
 * Temporary handler failures are retried with backoff, a failure is recorded (redacted) and kept for diagnosis, and a failed delivery can be
 * processed again, once, by an operator or by a redelivery of the same bytes. Handler writes commit together with the final status, so a
 * failed run leaves nothing behind and a successful one is never repeated.
 */
class WebhookRetryTest extends TestCase
{
    use RefreshDatabase;

    private WebhookEndpoint $endpoint;

    private string $secret;

    private User $owner;

    /** Scripted outcomes of the handler, in order: 'ok', 'fail' (temporary), 'permanent'. When it runs out, 'ok'. */
    private \ArrayObject $script;

    /** One entry per handler run: the outcome it produced. */
    private \ArrayObject $runs;

    protected function setUp(): void
    {
        parent::setUp();
        $this->owner = User::factory()->create();
        ['endpoint' => $this->endpoint, 'secret' => $this->secret] = app(WebhookEndpointService::class)->create('custom', $this->owner, 'EMC', requireEventId: true);
        $this->script = new \ArrayObject;
        $this->runs = new \ArrayObject;
        $script = $this->script;
        $runs = $this->runs;
        $owner = $this->owner;
        $this->app->bind('scripted.handler', fn () => new class($script, $runs, $owner) implements WebhookHandler
        {
            public function __construct(private \ArrayObject $script, private \ArrayObject $runs, private User $owner) {}

            public function supports(string $providerKey): bool
            {
                return $providerKey === 'custom';
            }

            public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
            {
                $next = $this->script->count() > count($this->runs) ? $this->script[count($this->runs)] : 'ok';
                $this->runs->append($next);
                // A database write that must commit only together with the "processed" status.
                Task::create(['user_id' => $this->owner->id, 'title' => 'From '.$delivery->delivery_id, 'status' => 'inbox']);
                if ($next === 'fail') {
                    throw new RuntimeException('EMC timed out. Authorization: Bearer sk_live_abcdefghijklmnop client_secret=hunter2hunter2');
                }
                if ($next === 'query') {
                    DB::insert('insert into no_such_table (note) values (?)', ['confidential-ticket-text']);
                }
                if ($next === 'permanent') {
                    throw new PermanentWebhookException('Unknown event type.');
                }
            }
        });
        $this->app->tag('scripted.handler', 'integrations.webhook_handlers');
        config(['integrations.webhooks.backoff_seconds' => [30, 120], 'integrations.webhooks.max_attempts' => 3]);
    }

    private function send(string $eventId, ?string $raw = null)
    {
        $raw ??= '{"event_id":"'.$eventId.'","type":"ticket.updated"}';
        $timestamp = now()->getTimestamp();

        return $this->call('POST', '/api/webhooks/'.$this->endpoint->public_id, [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_X_LIFEOS_TIMESTAMP' => (string) $timestamp,
            'HTTP_X_LIFEOS_SIGNATURE' => WebhookVerifier::sign($this->secret, $timestamp, $raw),
            'HTTP_X_LIFEOS_DELIVERY' => $eventId,
        ], $raw);
    }

    private function useDatabaseQueue(): void
    {
        config(['queue.default' => 'database']);
    }

    /** One queue worker pass, as the server's worker runs it (started with --tries=1, which the job overrides). */
    private function work(): void
    {
        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();
    }

    private function delivery(string $eventId): WebhookDelivery
    {
        return WebhookDelivery::where('delivery_id', $eventId)->firstOrFail();
    }

    public function test_a_temporary_failure_is_retried_after_the_backoff_and_then_processed_once(): void
    {
        $this->useDatabaseQueue();
        $this->freezeTime();
        $this->script->append('fail');
        $this->send('evt-1')->assertStatus(202)->assertJson(['status' => 'accepted']);

        $this->work();
        $delivery = $this->delivery('evt-1');
        $this->assertSame(['retrying', 1], [$delivery->status, $delivery->attempts]);
        $this->assertSame(now()->addSeconds(30)->toIso8601String(), $delivery->next_attempt_at->toIso8601String());
        $this->assertNotNull($delivery->payload, 'the payload is kept while it is retried');
        $this->assertSame(0, Task::count(), 'the failed run left nothing behind');
        $this->assertTrue(DB::table('jobs')->value('available_at') >= now()->addSeconds(30)->getTimestamp(), 'released with the backoff delay');

        $this->work();   // not due yet
        $this->assertSame(1, count($this->runs));

        $this->travel(31)->seconds();
        $this->work();
        $delivery->refresh();
        $this->assertSame(['processed', 2, null, null, null], [$delivery->status, $delivery->attempts, $delivery->last_error, $delivery->next_attempt_at, $delivery->payload]);
        $this->assertSame(['fail', 'ok'], $this->runs->getArrayCopy());
        $this->assertSame(1, Task::count(), 'the successful run wrote exactly once');
        $this->assertSame(0, DB::table('jobs')->count());
    }

    public function test_the_second_delay_is_used_for_the_second_retry_and_attempts_end_in_failed_with_the_payload_kept(): void
    {
        $this->useDatabaseQueue();
        $this->freezeTime();
        $this->script->exchangeArray(['fail', 'fail', 'fail']);
        $this->send('evt-2')->assertStatus(202);

        $this->work();
        $this->travel(30)->seconds();
        $this->work();
        $delivery = $this->delivery('evt-2');
        $this->assertSame(['retrying', 2], [$delivery->status, $delivery->attempts]);
        $this->assertSame(now()->addSeconds(120)->toIso8601String(), $delivery->next_attempt_at->toIso8601String());

        $this->travel(120)->seconds();
        $this->work();
        $delivery->refresh();
        $this->assertSame(['failed', 3, null], [$delivery->status, $delivery->attempts, $delivery->next_attempt_at]);
        $this->assertNotNull($delivery->processed_at);
        $this->assertSame('{"event_id":"evt-2","type":"ticket.updated"}', $delivery->payload, 'kept for a later retry');
        $this->assertSame(0, DB::table('jobs')->count(), 'no further automatic attempt');
        $this->assertSame(0, DB::table('failed_jobs')->count(), 'the outcome is on the delivery, not a stuck queue entry');
        $this->assertSame(0, Task::count());
    }

    public function test_the_stored_error_is_short_and_redacted(): void
    {
        $this->script->append('fail');
        $this->send('evt-3')->assertStatus(202);   // synchronous queue: no delay possible, so one failed run is final

        $delivery = $this->delivery('evt-3');
        $this->assertSame(['failed', 1], [$delivery->status, $delivery->attempts]);
        // A handler's own exception message can carry ticket content or secrets, so only its class is kept.
        $this->assertSame('RuntimeException', $delivery->last_error);
    }

    public function test_a_failed_run_is_logged_without_payload_content_sql_bindings_or_secrets_and_never_reported(): void
    {
        Exceptions::fake();
        $logged = [];
        Log::listen(function (MessageLogged $message) use (&$logged) {
            $logged[] = $message->message.' '.json_encode($message->context);
        });
        $this->script->exchangeArray(['fail', 'query', 'permanent']);
        $this->send('evt-l1')->assertStatus(202);
        $this->send('evt-l2')->assertStatus(202);
        $this->send('evt-l3')->assertStatus(202);

        Exceptions::assertNothingReported();
        $all = implode("\n", $logged);
        $this->assertCount(3, $logged);
        $this->assertStringContainsString('"error":"RuntimeException"', $all);
        $this->assertStringContainsString('"error":"QueryException: SQLSTATE ', $all);
        $this->assertStringContainsString('"error":"PermanentWebhookException: Unknown event type."', $all);
        foreach (['sk_live_abcdefghijklmnop', 'hunter2', 'EMC timed out', 'confidential-ticket-text', 'no_such_table', 'insert into'] as $secret) {
            $this->assertStringNotContainsString($secret, $all);
        }
    }

    public function test_a_database_error_is_stored_without_its_sql_or_bound_values(): void
    {
        $this->script->append('query');
        $this->send('evt-q')->assertStatus(202);

        $error = $this->delivery('evt-q')->last_error;
        $this->assertStringStartsWith('QueryException: SQLSTATE ', $error);
        $this->assertStringNotContainsString('confidential-ticket-text', $error);
        $this->assertStringNotContainsString('no_such_table', $error);
    }

    public function test_a_stuck_delivery_whose_job_was_lost_can_be_queued_again_once_it_is_overdue(): void
    {
        Queue::fake();   // the job is "lost": the delivery stays accepted
        $this->send('evt-stuck')->assertStatus(202);
        $delivery = $this->delivery('evt-stuck');
        $this->assertSame('accepted', $delivery->status);

        $this->artisan('lifeos:webhooks:retry', ['ids' => [$delivery->id]])->expectsOutputToContain('its job is not overdue yet')->assertSuccessful();
        $this->artisan('lifeos:webhooks:failed')->doesntExpectOutputToContain('evt-stuck')->assertSuccessful();
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);

        $this->travel(2)->hours();
        $this->artisan('lifeos:webhooks:failed')->expectsOutputToContain('evt-stuck')->assertSuccessful();
        $queue = app(WebhookDeliveryQueue::class);
        $stale = $delivery->fresh();
        $this->assertSame([true, false], [$queue->requeue($stale), $queue->requeue($stale)], 'two racing operators queue it once');
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);
        $this->assertFalse($queue->isStale($delivery->fresh()), 'queued again, it is due now and no longer stuck');
    }

    public function test_a_stuck_delivery_is_recovered_by_a_redelivery_and_by_retry_all_and_processed_once(): void
    {
        Queue::fake();
        $this->send('evt-s1')->assertStatus(202);
        $this->send('evt-s2')->assertStatus(202);
        $this->travel(2)->hours();
        Queue::fake();
        $this->send('evt-s1')->assertStatus(202)->assertJson(['status' => 'requeued']);
        $this->artisan('lifeos:webhooks:retry', ['--all' => true])->expectsOutputToContain('Queued 1')->assertSuccessful();
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);

        $requeued = Queue::pushed(ProcessWebhookDelivery::class);
        $this->assertSame([1, 1], $requeued->map(fn ($job) => $job->generation)->values()->all(), 'each requeue starts a new generation');
        foreach (['evt-s1', 'evt-s2'] as $id) {
            (new ProcessWebhookDelivery($this->delivery($id)->id))->handle();   // the "lost" job turns up late: generation 0, does nothing
            $this->assertSame('accepted', $this->delivery($id)->status);
        }
        $requeued->each(fn (ProcessWebhookDelivery $job) => $job->handle());
        $requeued->each(fn (ProcessWebhookDelivery $job) => $job->handle());   // a duplicate of the new job finds it processed
        $this->assertSame(['processed', 'processed'], WebhookDelivery::orderBy('id')->pluck('status')->all());
        $this->assertSame(2, count($this->runs));
        $this->assertSame(2, Task::count());
    }

    public function test_a_permanent_failure_is_not_retried(): void
    {
        $this->useDatabaseQueue();
        $this->script->append('permanent');
        $this->send('evt-4')->assertStatus(202);

        $this->work();

        $delivery = $this->delivery('evt-4');
        $this->assertSame(['failed', 1, 'PermanentWebhookException: Unknown event type.'], [$delivery->status, $delivery->attempts, $delivery->last_error]);
        $this->assertSame(0, DB::table('jobs')->count());
    }

    public function test_the_worker_giving_up_marks_the_delivery_failed(): void
    {
        Queue::fake();
        $this->send('evt-5')->assertStatus(202);
        $delivery = $this->delivery('evt-5');

        (new ProcessWebhookDelivery($delivery->id))->failed(new TimeoutExceededException('App\\Jobs\\ProcessWebhookDelivery has timed out.'));

        $this->assertSame(['failed', 'TimeoutExceededException: App\\Jobs\\ProcessWebhookDelivery has timed out.'], [$delivery->fresh()->status, $delivery->fresh()->last_error]);
    }

    public function test_the_worker_giving_up_late_never_overwrites_a_delivery_that_finished_meanwhile(): void
    {
        Queue::fake();
        $this->send('evt-late')->assertStatus(202);
        $delivery = $this->delivery('evt-late');
        (new ProcessWebhookDelivery($delivery->id))->handle();
        $processed = $delivery->fresh();
        $this->assertSame(['processed', 1], [$processed->status, $processed->attempts]);

        // A copy whose worker timed out reports its failure after another copy committed "processed".
        (new ProcessWebhookDelivery($delivery->id))->failed(new RuntimeException('Job timed out.'));
        $after = $delivery->fresh();
        $this->assertSame(['processed', 1, null, null], [$after->status, $after->attempts, $after->last_error, $after->next_attempt_at]);
        $this->assertSame($processed->processed_at->toIso8601String(), $after->processed_at->toIso8601String());

        foreach (['ignored', 'failed'] as $final) {
            $delivery->forceFill(['status' => $final, 'last_error' => 'kept'])->save();
            (new ProcessWebhookDelivery($delivery->id))->failed(null);
            $this->assertSame([$final, 'kept', 1], [$delivery->fresh()->status, $delivery->fresh()->last_error, $delivery->fresh()->attempts]);
        }
    }

    public function test_a_job_from_an_earlier_generation_can_neither_run_nor_record_a_failure_after_a_requeue(): void
    {
        $this->script->append('fail');
        $this->send('evt-gen')->assertStatus(202);   // synchronous queue: the failed run is final
        $delivery = $this->delivery('evt-gen');
        $this->assertSame(['failed', 0], [$delivery->status, $delivery->processing_generation]);
        Queue::fake();

        $this->assertTrue(app(WebhookDeliveryQueue::class)->requeue($delivery));
        $this->assertSame(['accepted', 1, 1], [$delivery->fresh()->status, $delivery->fresh()->processing_generation, $delivery->fresh()->attempts]);
        $new = Queue::pushed(ProcessWebhookDelivery::class)->sole();
        $this->assertSame(1, $new->generation);

        // The first job (generation 0) turns up late: its run and its failed() hook leave the new attempt alone.
        $old = new ProcessWebhookDelivery($delivery->id);
        $old->handle();
        $old->failed(new RuntimeException('Job timed out.'));
        $this->assertSame(['accepted', 1, null], [$delivery->fresh()->status, $delivery->fresh()->attempts, $delivery->fresh()->processed_at]);
        $this->assertSame(['fail'], $this->runs->getArrayCopy());

        $new->handle();
        $this->assertSame(['processed', 2], [$delivery->fresh()->status, $delivery->fresh()->attempts]);
        $old->failed(null);
        $new->failed(null);
        $this->assertSame('processed', $delivery->fresh()->status, 'no job of any generation turns a processed delivery back');
        $this->assertSame(1, Task::count());
    }

    public function test_a_processed_or_ignored_delivery_is_never_queued_again_even_from_a_stale_failed_copy(): void
    {
        $this->script->append('fail');
        $this->send('evt-done')->assertStatus(202);
        $staleCopy = $this->delivery('evt-done');   // read while it was failed, as an operator's list would be
        $this->assertSame('failed', $staleCopy->status);
        $this->send('evt-done')->assertStatus(202)->assertJson(['status' => 'requeued']);
        $this->assertSame('processed', $this->delivery('evt-done')->status);
        Queue::fake();

        $this->assertFalse(app(WebhookDeliveryQueue::class)->requeue($staleCopy));
        $this->artisan('lifeos:webhooks:retry', ['ids' => [$staleCopy->id]])->expectsOutputToContain('Queued 0')->assertSuccessful();
        $this->delivery('evt-done')->forceFill(['status' => 'ignored'])->save();
        $this->assertFalse(app(WebhookDeliveryQueue::class)->requeue($staleCopy));
        Queue::assertNothingPushed();
        $this->assertSame(['ignored', 1], [$this->delivery('evt-done')->status, $this->delivery('evt-done')->processing_generation]);
    }

    public function test_a_copy_of_the_job_for_a_delivery_that_is_already_processed_does_nothing(): void
    {
        $this->send('evt-6')->assertStatus(202);
        $id = $this->delivery('evt-6')->id;

        (new ProcessWebhookDelivery($id))->handle();
        dispatch(new ProcessWebhookDelivery($id));

        $this->assertSame(['ok'], $this->runs->getArrayCopy());
        $this->assertSame(1, Task::count());
    }

    public function test_on_postgresql_the_run_holds_the_delivery_row_lock_while_the_handlers_work(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Row locks are a PostgreSQL feature (SQLite serialises writers itself).');
        }
        Queue::fake();
        $this->send('evt-lock')->assertStatus(202);
        $id = $this->delivery('evt-lock')->id;
        DB::enableQueryLog();

        (new ProcessWebhookDelivery($id))->handle();

        $sql = collect(DB::getQueryLog())->pluck('query')->map(fn (string $q) => strtolower($q));
        $lock = $sql->search(fn (string $q) => str_contains($q, 'from "webhook_deliveries"') && str_ends_with(trim($q), 'for update'));
        $write = $sql->search(fn (string $q) => str_starts_with($q, 'insert into "tasks"'));
        $this->assertNotFalse($lock, 'the delivery row is selected FOR UPDATE');
        $this->assertNotFalse($write);
        $this->assertLessThan($write, $lock, 'the lock is taken before the handler writes');
        $this->assertSame('processed', $this->delivery('evt-lock')->status);
    }

    public function test_the_retry_command_processes_a_failed_delivery_once_and_skips_everything_else(): void
    {
        $this->script->append('fail');
        $this->send('evt-7')->assertStatus(202);
        $this->send('evt-8')->assertStatus(202);   // processed
        $failed = $this->delivery('evt-7');
        $this->assertSame('failed', $failed->status);

        $this->artisan('lifeos:webhooks:retry', ['ids' => [$failed->id, $this->delivery('evt-8')->id, 999999]])
            ->expectsOutputToContain("#{$failed->id}: queued again.")
            ->expectsOutputToContain('only failed or stuck deliveries can be processed again')
            ->expectsOutputToContain('#999999: not found')
            ->assertSuccessful();

        $this->assertSame('processed', $failed->fresh()->status);
        $this->assertSame(2, $failed->fresh()->attempts);
        $this->assertSame(['fail', 'ok', 'ok'], $this->runs->getArrayCopy());
        $this->assertSame(2, Task::count(), 'one task per successfully processed delivery');

        $this->artisan('lifeos:webhooks:retry', ['ids' => [$failed->id]])->expectsOutputToContain('Queued 0')->assertSuccessful();
        $this->assertSame(3, count($this->runs));
    }

    public function test_the_retry_command_needs_ids_or_all_and_skips_disabled_endpoints(): void
    {
        $this->artisan('lifeos:webhooks:retry')->assertFailed();

        $this->script->exchangeArray(['fail', 'fail']);
        $this->send('evt-9')->assertStatus(202);
        $this->send('evt-10')->assertStatus(202);
        $this->endpoint->forceFill(['enabled' => false])->save();
        $this->artisan('lifeos:webhooks:retry', ['--all' => true])->expectsOutputToContain('the endpoint is disabled')->expectsOutputToContain('Queued 0')->assertSuccessful();

        $this->endpoint->forceFill(['enabled' => true])->save();
        $this->artisan('lifeos:webhooks:retry', ['--all' => true])->expectsOutputToContain('Queued 2')->assertSuccessful();
        $this->assertSame(0, WebhookDelivery::where('status', 'failed')->count());
    }

    public function test_disabling_the_endpoint_stops_pending_deliveries_without_losing_them(): void
    {
        $this->useDatabaseQueue();
        $this->freezeTime();
        $this->script->append('fail');
        $this->send('evt-d1')->assertStatus(202);   // will be retrying when the endpoint is disabled
        $this->send('evt-d2')->assertStatus(202);   // still accepted (its job waits) when the endpoint is disabled
        $this->work();
        $this->assertSame(['retrying', 'accepted'], [$this->delivery('evt-d1')->status, $this->delivery('evt-d2')->status]);

        $this->endpoint->forceFill(['enabled' => false])->save();
        $this->work();   // evt-d2's job
        $this->travel(31)->seconds();
        $this->work();   // evt-d1's released retry

        foreach (['evt-d1', 'evt-d2'] as $id) {
            $delivery = $this->delivery($id);
            $this->assertSame(['failed', 'The endpoint is disabled.', null], [$delivery->status, $delivery->last_error, $delivery->next_attempt_at], $id);
            $this->assertNotNull($delivery->payload, 'kept until the endpoint is enabled again');
            $this->assertFalse(app(WebhookDeliveryQueue::class)->requeue($delivery), 'nothing is queued for a disabled endpoint');
        }
        $this->assertSame(['fail'], $this->runs->getArrayCopy(), 'no handler ran after the endpoint was disabled');
        $this->assertSame(0, DB::table('jobs')->count());
        $this->send('evt-d1')->assertNotFound();   // and the sender cannot reach it either

        $this->endpoint->forceFill(['enabled' => true])->save();
        $this->artisan('lifeos:webhooks:retry', ['--all' => true])->expectsOutputToContain('Queued 2')->assertSuccessful();
        $this->work();
        $this->work();
        $this->assertSame(['processed', 'processed'], [$this->delivery('evt-d1')->status, $this->delivery('evt-d2')->status]);
        $this->assertSame(['fail', 'ok', 'ok'], $this->runs->getArrayCopy());
        $this->assertSame(2, Task::count(), 'each delivery applied once');
    }

    public function test_requeueing_is_atomic_so_two_operators_queue_a_delivery_once(): void
    {
        $this->script->append('fail');
        $this->send('evt-11')->assertStatus(202);
        $delivery = $this->delivery('evt-11');
        Queue::fake();

        $queue = app(WebhookDeliveryQueue::class);
        $first = $queue->requeue($delivery);
        $second = $queue->requeue($delivery);   // the same stale "failed" model, as a second operator would hold it

        $this->assertSame([true, false], [$first, $second]);
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);
    }

    public function test_a_redelivery_of_a_failed_event_with_the_same_bytes_is_processed_again_but_a_different_body_never_is(): void
    {
        $this->script->append('fail');
        $raw = '{"event_id":"evt-12","type":"ticket.updated"}';
        $this->send('evt-12', $raw)->assertStatus(202)->assertJson(['status' => 'accepted']);
        $this->assertSame('failed', $this->delivery('evt-12')->status);

        $tampered = '{"event_id":"evt-12","type":"ticket.closed"}';
        $this->send('evt-12', $tampered)->assertStatus(202)->assertJson(['status' => 'duplicate']);
        $this->assertSame('failed', $this->delivery('evt-12')->status);
        $this->assertSame($raw, $this->delivery('evt-12')->payload);

        $this->send('evt-12', $raw)->assertStatus(202)->assertJson(['status' => 'requeued']);
        $this->assertSame('processed', $this->delivery('evt-12')->status);
        $this->send('evt-12', $raw)->assertStatus(202)->assertJson(['status' => 'duplicate']);
        $this->assertSame(['fail', 'ok'], $this->runs->getArrayCopy());
        $this->assertSame(1, WebhookDelivery::count());
    }

    public function test_a_redelivery_while_the_delivery_is_queued_or_retrying_is_only_a_duplicate(): void
    {
        $this->useDatabaseQueue();
        $this->freezeTime();
        $this->script->append('fail');
        $this->send('evt-r')->assertStatus(202);
        $this->send('evt-r')->assertStatus(202)->assertJson(['status' => 'duplicate']);   // accepted, job waiting
        $this->assertSame(1, DB::table('jobs')->count());

        $this->work();
        $this->assertSame('retrying', $this->delivery('evt-r')->status);
        $this->send('evt-r')->assertStatus(202)->assertJson(['status' => 'duplicate']);   // retrying, release waiting
        $this->assertSame(1, DB::table('jobs')->count(), 'no second job');
        $this->assertSame(1, count($this->runs));
    }

    public function test_a_worker_that_exhausted_the_attempts_without_finishing_marks_the_delivery_failed(): void
    {
        $this->useDatabaseQueue();
        $this->send('evt-x')->assertStatus(202);
        // As after repeated crashes or timeouts: the job comes back with more reservations than it may have.
        DB::table('jobs')->update(['attempts' => 3]);

        $this->work();

        $delivery = $this->delivery('evt-x');
        $this->assertSame('failed', $delivery->status);
        $this->assertStringContainsString('MaxAttemptsExceededException', (string) $delivery->last_error);
        $this->assertSame([], $this->runs->getArrayCopy(), 'the handler never ran');
        $this->assertNotNull($delivery->payload, 'kept for lifeos:webhooks:retry');
    }

    public function test_a_failed_delivery_whose_payload_is_gone_is_refused_unless_a_verified_redelivery_brings_the_bytes_back(): void
    {
        $this->script->append('fail');
        $raw = '{"event_id":"evt-p","type":"ticket.updated"}';
        $this->send('evt-p', $raw)->assertStatus(202);
        $delivery = $this->delivery('evt-p');
        $delivery->forceFill(['payload' => null])->save();

        $this->artisan('lifeos:webhooks:retry', ['ids' => [$delivery->id]])->expectsOutputToContain('the payload is no longer stored')->assertSuccessful();
        $this->assertSame('failed', $delivery->fresh()->status);

        $seen = new \ArrayObject;
        $this->app->bind('payload.handler', fn () => new class($seen) implements WebhookHandler
        {
            public function __construct(private \ArrayObject $seen) {}

            public function supports(string $providerKey): bool
            {
                return true;
            }

            public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
            {
                $this->seen->append($delivery->payload);
            }
        });
        $this->app->tag('payload.handler', 'integrations.webhook_handlers');
        $this->send('evt-p', $raw)->assertStatus(202)->assertJson(['status' => 'requeued']);

        $this->assertSame([$raw], $seen->getArrayCopy(), 'the handler got the restored bytes');
        $this->assertSame('processed', $delivery->fresh()->status);
    }

    public function test_the_failed_list_shows_diagnostics_but_never_the_payload(): void
    {
        $this->script->append('fail');
        $this->send('evt-13', '{"event_id":"evt-13","note":"confidential-ticket-text"}')->assertStatus(202);
        $this->send('evt-14')->assertStatus(202);

        $this->artisan('lifeos:webhooks:failed')
            ->expectsOutputToContain('evt-13')
            ->doesntExpectOutputToContain('evt-14')
            ->doesntExpectOutputToContain('confidential-ticket-text')
            ->doesntExpectOutputToContain('sk_live_abcdefghijklmnop')
            ->assertSuccessful();
        $this->artisan('lifeos:webhooks:failed', ['--status' => ['bogus']])->assertFailed();
    }

    public function test_pruning_still_removes_old_failed_deliveries_and_their_payloads(): void
    {
        $this->script->append('fail');
        $this->send('evt-15')->assertStatus(202);
        $this->travel(8)->days();

        $this->artisan('lifeos:integrations:prune')->assertSuccessful();

        $this->assertSame(0, WebhookDelivery::count());
    }
}
