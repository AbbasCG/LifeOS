<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\WebhookEndpointService;
use App\Integrations\Webhooks\WebhookHandler;
use App\Integrations\Webhooks\WebhookVerifier;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\User;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class WebhookTest extends TestCase
{
    use RefreshDatabase;

    private WebhookEndpoint $endpoint;

    private string $secret;

    protected function setUp(): void
    {
        parent::setUp();
        ['endpoint' => $this->endpoint, 'secret' => $this->secret] = app(WebhookEndpointService::class)->create('custom', null, 'EMC orders');
    }

    /** Send a signed webhook with the exact raw bytes given. */
    private function send(string $raw, array $overrides = [], ?string $publicId = null)
    {
        $timestamp = $overrides['timestamp'] ?? time();
        $headers = [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_X_LIFEOS_TIMESTAMP' => (string) $timestamp,
            'HTTP_X_LIFEOS_SIGNATURE' => $overrides['signature'] ?? WebhookVerifier::sign($overrides['secret'] ?? $this->secret, (int) $timestamp, $raw),
            'HTTP_X_LIFEOS_DELIVERY' => $overrides['delivery'] ?? 'evt-1',
        ];
        foreach (['timestamp' => 'HTTP_X_LIFEOS_TIMESTAMP', 'signature' => 'HTTP_X_LIFEOS_SIGNATURE', 'delivery' => 'HTTP_X_LIFEOS_DELIVERY'] as $key => $header) {
            if (array_key_exists($key, $overrides) && $overrides[$key] === null) {
                unset($headers[$header]);
            }
        }

        return $this->call('POST', '/api/webhooks/'.($publicId ?? $this->endpoint->public_id), [], [], [], $headers, $raw);
    }

    public function test_a_correctly_signed_delivery_is_accepted_recorded_and_queued(): void
    {
        Queue::fake();
        $this->send('{"order":42}')->assertStatus(202)->assertJson(['status' => 'accepted']);
        $delivery = WebhookDelivery::first();
        $this->assertSame(['evt-1', hash('sha256', '{"order":42}'), 12], [$delivery->delivery_id, $delivery->payload_sha256, $delivery->size]);
        $this->assertSame('{"order":42}', $delivery->payload);
        $this->assertStringNotContainsString('order', (string) DB::table('webhook_deliveries')->value('payload'), 'the payload is encrypted at rest');
        Queue::assertPushed(ProcessWebhookDelivery::class, 1);
        $this->assertNotNull($this->endpoint->fresh()->last_delivery_at);
    }

    public function test_the_signature_covers_the_raw_bytes_not_a_re_encoded_body(): void
    {
        Queue::fake();
        $raw = '{ "order" :   42 }';   // odd spacing must verify exactly as sent
        $this->send($raw)->assertStatus(202);
        $this->send($raw, ['signature' => WebhookVerifier::sign($this->secret, time(), '{"order":42}'), 'delivery' => 'evt-2'])->assertStatus(401);
    }

    public function test_bad_signatures_are_refused_with_one_message_and_nothing_is_recorded(): void
    {
        Queue::fake();
        $raw = '{"a":1}';
        $cases = [
            'wrong secret' => ['secret' => 'whsec_wrong'],
            'tampered' => ['signature' => WebhookVerifier::sign($this->secret, time(), '{"a":2}')],
            'missing signature' => ['signature' => null],
            'garbage signature' => ['signature' => 'sha256=nothex'],
            'wrong scheme' => ['signature' => 'sha1='.str_repeat('a', 40)],
            'missing timestamp' => ['timestamp' => null],
            'non numeric timestamp' => ['timestamp' => 'yesterday'],
        ];
        $messages = [];
        foreach ($cases as $name => $override) {
            $response = $this->send($raw, $override);
            $this->assertSame(401, $response->getStatusCode(), $name);
            $messages[] = $response->json('message');
        }
        $this->assertCount(1, array_unique($messages), 'the cause is not revealed');
        $this->assertSame(0, WebhookDelivery::count());
        Queue::assertNothingPushed();
    }

    public function test_old_and_future_timestamps_are_refused_even_with_a_valid_signature(): void
    {
        $raw = '{"a":1}';
        foreach ([time() - 301, time() + 301, time() - 86400] as $stale) {
            $this->send($raw, ['timestamp' => $stale])->assertStatus(401);
        }
        $this->send($raw, ['timestamp' => time() - 290, 'delivery' => 'evt-ok'])->assertStatus(202);
    }

    public function test_a_redelivery_is_acknowledged_but_processed_only_once(): void
    {
        Queue::fake();
        $this->send('{"a":1}', ['delivery' => 'same'])->assertStatus(202)->assertJson(['status' => 'accepted']);
        $this->send('{"a":1}', ['delivery' => 'same'])->assertStatus(202)->assertJson(['status' => 'duplicate']);
        $this->send('{"a":1}', ['delivery' => 'other'])->assertStatus(202)->assertJson(['status' => 'accepted']);
        $this->assertSame(2, WebhookDelivery::count());
        Queue::assertPushed(ProcessWebhookDelivery::class, 2);
    }

    public function test_the_same_delivery_id_on_another_endpoint_is_independent(): void
    {
        Queue::fake();
        ['endpoint' => $other, 'secret' => $otherSecret] = app(WebhookEndpointService::class)->create('custom', null, 'Other');
        $this->send('{"a":1}', ['delivery' => 'x'])->assertStatus(202);
        $this->send('{"a":1}', ['delivery' => 'x', 'secret' => $otherSecret], $other->public_id)->assertStatus(202)->assertJson(['status' => 'accepted']);
        $this->send('{"a":1}', ['delivery' => 'x', 'secret' => $this->secret], $other->public_id)->assertStatus(401);
    }

    public function test_a_valid_delivery_needs_a_well_formed_delivery_id(): void
    {
        foreach ([null, '', 'has space', str_repeat('a', 121), "bad\nid", 'sémi'] as $id) {
            $this->send('{"a":1}', ['delivery' => $id])->assertStatus(400);
        }
        $this->assertSame(0, WebhookDelivery::count());
    }

    public function test_unknown_and_disabled_endpoints_look_identical(): void
    {
        $unknown = $this->send('{}', [], '00000000-0000-4000-8000-000000000000');
        $this->endpoint->forceFill(['enabled' => false])->save();
        $disabled = $this->send('{}');
        $this->assertSame([404, 404], [$unknown->getStatusCode(), $disabled->getStatusCode()]);
        $this->assertSame($unknown->getContent(), $disabled->getContent());
        $this->call('POST', '/api/webhooks/not-a-uuid')->assertNotFound();
    }

    public function test_oversize_payloads_are_refused_before_verification(): void
    {
        config(['integrations.webhooks.max_bytes' => 100]);
        $big = str_repeat('x', 101);
        $this->send($big)->assertStatus(413);
        $this->assertSame(0, WebhookDelivery::count());
        $this->send(str_repeat('x', 100), ['delivery' => 'fits'])->assertStatus(202);
    }

    public function test_secret_rotation_keeps_the_old_secret_valid_for_the_overlap_window_only(): void
    {
        Queue::fake();
        $new = app(WebhookEndpointService::class)->rotate($this->endpoint);
        $this->assertNotSame($this->secret, $new);
        $this->send('{"a":1}', ['secret' => $new, 'delivery' => 'a'])->assertStatus(202);
        $this->send('{"a":1}', ['secret' => $this->secret, 'delivery' => 'b'])->assertStatus(202);   // old secret, inside the window
        $this->travel(25)->hours();
        $this->send('{"a":1}', ['secret' => $this->secret, 'delivery' => 'c', 'timestamp' => time()])->assertStatus(401);
        $this->send('{"a":1}', ['secret' => $new, 'delivery' => 'd', 'timestamp' => time()])->assertStatus(202);
    }

    public function test_the_receiver_is_rate_limited_per_endpoint_and_address(): void
    {
        for ($i = 0; $i < 120; $i++) {
            $this->send('{}', ['signature' => 'sha256='.str_repeat('0', 64)])->assertStatus(401);
        }
        $this->send('{}', ['signature' => 'sha256='.str_repeat('0', 64)])->assertStatus(429);
    }

    public function test_the_receiver_uses_no_session_cookies_or_csrf(): void
    {
        $route = Route::getRoutes()->getByAction('App\Http\Controllers\WebhookController@receive');
        $stack = app('router')->gatherRouteMiddleware($route);
        foreach ([StartSession::class, PreventRequestForgery::class, EncryptCookies::class] as $class) {
            $this->assertNotContains($class, $stack, "{$class} must not run for webhooks");
        }
        $this->assertNotEmpty(array_filter($stack, fn ($m) => is_string($m) && str_ends_with($m, 'ThrottleRequests:webhooks')), 'the webhook limiter applies');
        $this->assertNotContains('auth:sanctum', $stack);
        $response = $this->send('{}', ['delivery' => 'cookie-check']);
        $this->assertSame([], $response->headers->getCookies(), 'no Set-Cookie on a webhook response');
    }

    public function test_secrets_are_encrypted_hidden_and_shown_once(): void
    {
        $this->assertStringNotContainsString($this->secret, json_encode((array) DB::table('webhook_endpoints')->first()));
        $this->assertArrayNotHasKey('secret', $this->endpoint->fresh()->toArray());
        $this->assertStringStartsWith('whsec_', $this->secret);
        $this->assertGreaterThanOrEqual(40, strlen($this->secret));
    }

    public function test_a_tagged_handler_receives_the_verified_delivery_and_the_payload_is_dropped(): void
    {
        $seen = new \ArrayObject;
        $this->app->bind('test.handler', fn () => new class($seen) implements WebhookHandler
        {
            public function __construct(private \ArrayObject $seen) {}

            public function supports(string $providerKey): bool
            {
                return $providerKey === 'custom';
            }

            public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
            {
                $this->seen->append([$endpoint->name, $delivery->payload]);
            }
        });
        $this->app->tag('test.handler', 'integrations.webhook_handlers');
        $this->send('{"order":7}')->assertStatus(202);   // the queue is synchronous in tests
        $this->assertSame([['EMC orders', '{"order":7}']], $seen->getArrayCopy());
        $delivery = WebhookDelivery::first();
        $this->assertSame('processed', $delivery->status);
        $this->assertNull($delivery->payload, 'the stored payload is removed once handled');
    }

    public function test_a_delivery_nobody_handles_is_recorded_as_ignored_and_a_failing_handler_is_marked_failed(): void
    {
        $this->send('{"x":1}', ['delivery' => 'one'])->assertStatus(202);
        $this->assertSame('ignored', WebhookDelivery::where('delivery_id', 'one')->value('status'));

        $this->app->bind('boom.handler', fn () => new class implements WebhookHandler
        {
            public function supports(string $providerKey): bool
            {
                return true;
            }

            public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
            {
                throw new \RuntimeException('connector exploded');
            }
        });
        $this->app->tag('boom.handler', 'integrations.webhook_handlers');
        $this->send('{"x":2}', ['delivery' => 'two'])->assertStatus(202);
        $this->assertSame('failed', WebhookDelivery::where('delivery_id', 'two')->value('status'));
    }

    public function test_old_deliveries_are_pruned(): void
    {
        Queue::fake();
        $this->send('{"a":1}', ['delivery' => 'old'])->assertStatus(202);
        $this->travel(8)->days();
        $this->send('{"a":1}', ['delivery' => 'new', 'timestamp' => time()])->assertStatus(202);
        $this->artisan('lifeos:integrations:prune')->assertSuccessful();
        $this->assertSame(['new'], WebhookDelivery::pluck('delivery_id')->all());
    }

    public function test_owner_deletion_removes_their_endpoints(): void
    {
        $user = User::factory()->create();
        app(WebhookEndpointService::class)->create('custom', $user, 'Mine');
        $user->delete();
        $this->assertSame(1, WebhookEndpoint::count());   // only the system endpoint from setUp remains
    }
}
