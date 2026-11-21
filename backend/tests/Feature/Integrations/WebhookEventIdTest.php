<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\WebhookEndpointService;
use App\Integrations\Webhooks\WebhookVerifier;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * Replay protection with a signed event id. The HMAC covers "<timestamp>.<raw body>" but not the X-LifeOS-Delivery header, so the event id
 * a sender puts in its body is what ties the unique delivery id to the signature: a captured request replayed under a new delivery id is
 * refused. Endpoints that do not require it keep accepting bodies without an event_id exactly as before.
 */
class WebhookEventIdTest extends TestCase
{
    use RefreshDatabase;

    private WebhookEndpoint $legacy;

    private string $legacySecret;

    private WebhookEndpoint $strict;

    private string $strictSecret;

    protected function setUp(): void
    {
        parent::setUp();
        Queue::fake();
        $service = app(WebhookEndpointService::class);
        ['endpoint' => $this->legacy, 'secret' => $this->legacySecret] = $service->create('custom', null, 'Existing sender');
        ['endpoint' => $this->strict, 'secret' => $this->strictSecret] = $service->create('custom', null, 'New connector', requireEventId: true);
    }

    /**
     * @param  array{timestamp?: int, signature?: string, secret?: string}  $overrides
     */
    private function send(WebhookEndpoint $endpoint, string $raw, string $delivery, array $overrides = [])
    {
        $timestamp = $overrides['timestamp'] ?? now()->getTimestamp();
        $secret = $overrides['secret'] ?? ($endpoint->is($this->strict) ? $this->strictSecret : $this->legacySecret);

        return $this->call('POST', '/api/webhooks/'.$endpoint->public_id, [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_X_LIFEOS_TIMESTAMP' => (string) $timestamp,
            'HTTP_X_LIFEOS_SIGNATURE' => $overrides['signature'] ?? WebhookVerifier::sign($secret, (int) $timestamp, $raw),
            'HTTP_X_LIFEOS_DELIVERY' => $delivery,
        ], $raw);
    }

    public function test_new_endpoints_do_not_require_an_event_id_unless_asked(): void
    {
        $this->assertFalse($this->legacy->fresh()->require_event_id);
        $this->assertTrue($this->strict->fresh()->require_event_id);
    }

    public function test_a_body_event_id_equal_to_the_delivery_header_is_accepted_on_both_kinds_of_endpoint(): void
    {
        $raw = '{"event_id":"evt-100","type":"ticket.assigned"}';
        $this->send($this->strict, $raw, 'evt-100')->assertStatus(202)->assertJson(['status' => 'accepted']);
        $this->send($this->legacy, $raw, 'evt-100')->assertStatus(202)->assertJson(['status' => 'accepted']);
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);
    }

    public function test_a_captured_request_replayed_under_a_new_delivery_id_is_refused_and_not_recorded(): void
    {
        $this->freezeTime();
        $raw = '{"event_id":"evt-1","type":"ticket.closed"}';
        $timestamp = now()->getTimestamp();
        foreach ([$this->strict, $this->legacy] as $endpoint) {
            $secret = $endpoint->is($this->strict) ? $this->strictSecret : $this->legacySecret;
            $captured = ['timestamp' => $timestamp, 'signature' => WebhookVerifier::sign($secret, $timestamp, $raw)];
            $this->send($endpoint, $raw, 'evt-1', $captured)->assertStatus(202)->assertJson(['status' => 'accepted']);
            // Same bytes, same timestamp and signature (all still valid), only the unsigned header is changed.
            $this->send($endpoint, $raw, 'evt-1-replay', $captured)->assertStatus(400);
            $this->send($endpoint, $raw, 'evt-1', $captured)->assertStatus(202)->assertJson(['status' => 'duplicate']);
        }
        $this->assertSame(['evt-1', 'evt-1'], WebhookDelivery::orderBy('id')->pluck('delivery_id')->all());
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);
    }

    public function test_a_malformed_or_mismatched_event_id_is_refused_with_one_message(): void
    {
        $bodies = [
            '{"event_id":42}', '{"event_id":null}', '{"event_id":["evt-2"]}', '{"event_id":""}', '{"event_id":"has space"}',
            '{"event_id":"'.str_repeat('a', 121).'"}', '{"event_id":"evt-2\n"}', '{"event_id":"EVT-2"}', '{"event_id":"evt-3"}',
        ];
        $messages = [];
        foreach ($bodies as $raw) {
            foreach ([$this->strict, $this->legacy] as $endpoint) {
                $response = $this->send($endpoint, $raw, 'evt-2');
                $this->assertSame(400, $response->getStatusCode(), $raw);
                $messages[] = $response->json('message');
            }
        }
        $this->assertCount(1, array_unique($messages));
        $this->assertSame(0, WebhookDelivery::count());
        Queue::assertNothingPushed();
    }

    public function test_an_endpoint_that_requires_it_refuses_bodies_without_a_top_level_event_id(): void
    {
        foreach (['{"type":"ticket.updated"}', '{"data":{"event_id":"evt-4"}}', '[{"event_id":"evt-4"}]', 'plain text', '', '{not json'] as $raw) {
            $this->send($this->strict, $raw, 'evt-4')->assertStatus(400);
        }
        $this->assertSame(0, WebhookDelivery::count());
        $this->send($this->strict, '{"data":{},"event_id":"evt-4"}', 'evt-4')->assertStatus(202);
    }

    public function test_a_body_that_mentions_event_id_but_cannot_be_decoded_is_refused_instead_of_skipping_the_check(): void
    {
        $deep = str_repeat('{"a":', 70).'1'.str_repeat('}', 70);
        foreach ([
            "\xEF\xBB\xBF".'{"event_id":"evt-6"}' => 'evt-6-replay',            // BOM: decoded, and the id does not match
            '{"event_id":"evt-7","note":"'."\xC3\x28".'"}' => 'evt-7-replay',      // invalid UTF-8
            '{"event_id":"evt-8","x":'.$deep.'}' => 'evt-8-replay',                // nested deeper than the decoder allows
            '{"event_id":"evt-9",' => 'evt-9-replay',                              // truncated JSON
        ] as $raw => $delivery) {
            $this->send($this->legacy, $raw, $delivery)->assertStatus(400);
            $this->send($this->strict, $raw, $delivery)->assertStatus(400);
        }
        $this->assertSame(0, WebhookDelivery::count());
        $this->send($this->legacy, "\xEF\xBB\xBF".'{"event_id":"evt-6"}', 'evt-6')->assertStatus(202);
        $this->send($this->strict, "\xEF\xBB\xBF".'{"event_id":"evt-6"}', 'evt-6')->assertStatus(202);
    }

    public function test_an_existing_endpoint_can_be_switched_to_require_the_event_id_and_back(): void
    {
        $this->send($this->legacy, '{"order":1}', 'before')->assertStatus(202);

        $this->artisan('lifeos:webhooks:require-event-id', ['publicId' => $this->legacy->public_id])->expectsOutputToContain('now refuses')->assertSuccessful();
        $this->assertTrue($this->legacy->fresh()->require_event_id);
        $this->send($this->legacy, '{"order":1}', 'after')->assertStatus(400);
        $this->send($this->legacy, '{"order":1,"event_id":"after"}', 'after')->assertStatus(202);

        $this->artisan('lifeos:webhooks:require-event-id', ['publicId' => $this->legacy->public_id, '--off' => true])->assertSuccessful();
        $this->send($this->legacy, '{"order":2}', 'off-again')->assertStatus(202);
        $this->artisan('lifeos:webhooks:require-event-id', ['publicId' => '00000000-0000-4000-8000-000000000000'])->assertFailed();
    }

    public function test_a_matching_event_id_does_not_rescue_a_stale_timestamp_or_an_expired_secret(): void
    {
        $this->freezeTime();
        $raw = '{"event_id":"evt-t"}';
        foreach ([now()->getTimestamp() - 301, now()->getTimestamp() + 301] as $stale) {
            $this->send($this->strict, $raw, 'evt-t', ['timestamp' => $stale])->assertStatus(401);
        }
        $old = $this->strictSecret;
        $new = app(WebhookEndpointService::class)->rotate($this->strict);
        $this->send($this->strict, '{"event_id":"evt-old"}', 'evt-old', ['secret' => $old])->assertStatus(202);   // inside the overlap
        $this->send($this->strict, '{"event_id":"evt-new"}', 'evt-new', ['secret' => $new])->assertStatus(202);
        $this->travel(25)->hours();
        $this->send($this->strict, '{"event_id":"evt-late"}', 'evt-late', ['secret' => $old, 'timestamp' => now()->getTimestamp()])->assertStatus(401);
        $this->assertSame(['evt-old', 'evt-new'], WebhookDelivery::orderBy('id')->pluck('delivery_id')->all());
    }

    public function test_existing_senders_without_an_event_id_behave_exactly_as_before(): void
    {
        foreach (['{"order":42}' => 'a', 'plain text' => 'b', '[1,2,3]' => 'c', '' => 'd', '{"data":{"event_id":"other"}}' => 'e', '{broken' => 'f'] as $raw => $delivery) {
            $this->send($this->legacy, $raw, $delivery)->assertStatus(202)->assertJson(['status' => 'accepted']);
        }
        $this->send($this->legacy, '{"order":42}', 'a')->assertStatus(202)->assertJson(['status' => 'duplicate']);
        $this->assertSame(6, WebhookDelivery::count());
    }

    public function test_the_event_id_is_only_looked_at_after_the_signature_so_it_reveals_nothing_to_an_unsigned_caller(): void
    {
        $this->send($this->strict, '{"event_id":"evt-5"}', 'different', ['secret' => 'whsec_wrong'])->assertStatus(401);
        $this->send($this->strict, '{"no":"id"}', 'evt-5', ['secret' => 'whsec_wrong'])->assertStatus(401);
        $this->assertSame(0, WebhookDelivery::count());
    }
}
