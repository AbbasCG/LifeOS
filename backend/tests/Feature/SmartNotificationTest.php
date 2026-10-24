<?php

namespace Tests\Feature;

use App\Integrations\Push\WebPush;
use App\Jobs\SendPushNotification;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\InboxNotification;
use App\Models\PushSubscription;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\Notifier;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class SmartNotificationTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    /** @var array{p256dh: string, auth: string, private: \OpenSSLAsymmetricKey} */
    private array $device;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-01-04 08:00:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00']]);
        $keys = WebPush::generateKeys();
        config(['services.webpush.public_key' => $keys['public_key'], 'services.webpush.private_key' => $keys['private_key'], 'services.webpush.subject' => 'mailto:ops@example.com']);
        $ua = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $ec = openssl_pkey_get_details($ua)['ec'];
        $this->device = ['p256dh' => WebPush::base64UrlEncode("\x04".str_pad($ec['x'], 32, "\0", STR_PAD_LEFT).str_pad($ec['y'], 32, "\0", STR_PAD_LEFT)), 'auth' => WebPush::base64UrlEncode(random_bytes(16)), 'private' => $ua];
    }

    private function subscribe(string $endpoint = 'https://fcm.googleapis.com/fcm/send/abc'): void
    {
        $this->actingAs($this->user)->postJson('/api/push/subscriptions', ['endpoint' => $endpoint, 'keys' => ['p256dh' => $this->device['p256dh'], 'auth' => $this->device['auth']]])->assertCreated();
    }

    private function prefs(array $prefs): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->preferences(), $prefs)]);
    }

    /**
     * Decrypt an aes128gcm body exactly as a browser would (RFC 8291), proving the payload is readable by the device.
     */
    private function decrypt(string $body): string
    {
        $salt = substr($body, 0, 16);
        $serverPublic = substr($body, 21, 65);
        $shared = openssl_pkey_derive(WebPush::publicKeyFromPoint($serverPublic), $this->device['private'], 32);
        $ua = WebPush::base64UrlDecode($this->device['p256dh']);
        $ikm = hash_hkdf('sha256', $shared, 32, "WebPush: info\0".$ua.$serverPublic, WebPush::base64UrlDecode($this->device['auth']));
        $cipher = substr($body, 86);
        $plain = openssl_decrypt(substr($cipher, 0, -16), 'aes-128-gcm', hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt), OPENSSL_RAW_DATA, hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt), substr($cipher, -16));

        return substr((string) $plain, 0, -1);
    }

    public function test_push_is_encrypted_signed_and_delivered_once(): void
    {
        $this->subscribe();
        $captured = [];
        Http::fake(['fcm.googleapis.com/*' => function (HttpRequest $request) use (&$captured) {
            $captured[] = $request;

            return Http::response('', 201);
        }]);

        $notification = app(Notifier::class)->send($this->user, 'reminders', 'k1', 'Call the bank', ['link' => '/tasks']);
        SendPushNotification::dispatchSync($notification->id);

        $this->assertCount(1, $captured);
        $this->assertSame('sent', $notification->fresh()->push_status);
        $this->assertSame('aes128gcm', $captured[0]->header('Content-Encoding')[0]);
        $this->assertMatchesRegularExpression('/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/', $captured[0]->header('Authorization')[0]);
        $payload = json_decode($this->decrypt($captured[0]->body()), true);
        $this->assertSame('Call the bank', $payload['title']);
        $this->assertSame('/tasks', $payload['link']);
        $this->assertNull(app(Notifier::class)->send($this->user, 'reminders', 'k1', 'Call the bank'), 'Duplicate keys must not notify again');
    }

    public function test_gone_subscriptions_are_removed_and_transient_errors_retry(): void
    {
        $this->subscribe();
        $status = 503;
        Http::fake(['fcm.googleapis.com/*' => function () use (&$status) {
            return Http::response('', $status);
        }]);
        $notification = app(Notifier::class)->send($this->user, 'reminders', 'k2', 'Retry me');

        Queue::fake();
        $job = (new SendPushNotification($notification->id))->withFakeQueueInteractions();
        $job->handle(app(WebPush::class));
        $job->assertReleased();
        $this->assertSame('retrying', $notification->fresh()->push_status);

        $status = 410;
        (new SendPushNotification($notification->id))->withFakeQueueInteractions()->handle(app(WebPush::class));
        $this->assertSame(0, PushSubscription::count());
        $this->assertSame('failed', $notification->fresh()->push_status);
    }

    public function test_category_preferences_quiet_hours_and_focus_are_respected(): void
    {
        Queue::fake();
        $this->subscribe();
        $notifier = app(Notifier::class);
        $this->prefs(['notification_channels' => ['planning' => ['enabled' => false, 'push' => false], 'reminders' => ['enabled' => true, 'push' => false]]]);

        $this->assertNull($notifier->send($this->user->fresh(), 'planning', 'p1', 'Plan'));
        $this->assertNull($notifier->send($this->user->fresh(), 'reminders', 'r1', 'In-app only')->push_status);
        Queue::assertNothingPushed();

        FocusSession::create(['user_id' => $this->user->id, 'duration_seconds' => 1500, 'resumed_at' => now(), 'status' => 'running']);
        $this->assertSame('suppressed', $notifier->send($this->user->fresh(), 'deadlines', 'd1', 'Due')->push_status);
        Queue::assertNothingPushed();

        $this->prefs(['quiet_start' => '07:00', 'quiet_end' => '09:00']);
        $this->assertNull($notifier->send($this->user->fresh(), 'calendar', 'c1', 'Quiet'));
        $this->assertNotNull($notifier->send($this->user->fresh(), 'system', 's1', 'Security notice'));
    }

    public function test_recurring_and_custom_lead_event_reminders(): void
    {
        $tz = CarbonImmutable::parse('2027-01-01 08:20:00', 'UTC');
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Standup', 'starts_at' => $tz, 'ends_at' => $tz->addMinutes(15), 'timezone' => 'UTC', 'recurrence' => ['freq' => 'daily', 'interval' => 1], 'kind' => 'fixed']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Flight', 'starts_at' => now()->addMinutes(110), 'ends_at' => now()->addHours(4), 'remind_minutes' => 120, 'kind' => 'fixed']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Later', 'starts_at' => now()->addHours(3), 'ends_at' => now()->addHours(4), 'kind' => 'fixed']);

        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->artisan('lifeos:reminders')->assertSuccessful();

        $titles = InboxNotification::where('category', 'calendar')->pluck('title')->sort()->values()->all();
        $this->assertSame(['Upcoming: Flight', 'Upcoming: Standup'], $titles);
        $this->assertSame('Starts at 08:20', InboxNotification::where('title', 'Upcoming: Standup')->value('body'));
    }

    public function test_focus_completion_reminder_is_sent_once_even_during_focus(): void
    {
        FocusSession::create(['user_id' => $this->user->id, 'duration_seconds' => 1500, 'elapsed_seconds' => 0, 'resumed_at' => now()->subMinutes(26), 'status' => 'running']);

        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->artisan('lifeos:reminders')->assertSuccessful();

        $this->assertSame(1, InboxNotification::where('category', 'focus')->count());
    }

    public function test_subscription_api_validates_hosts_keys_and_ownership(): void
    {
        $this->actingAs($this->user)->getJson('/api/push/config')->assertOk()->assertJsonPath('configured', true)->assertJsonMissingPath('private_key');
        $this->actingAs($this->user)->postJson('/api/push/subscriptions', ['endpoint' => 'https://169.254.169.254/latest', 'keys' => ['p256dh' => $this->device['p256dh'], 'auth' => $this->device['auth']]])->assertUnprocessable();
        $this->actingAs($this->user)->postJson('/api/push/subscriptions', ['endpoint' => 'http://fcm.googleapis.com/x', 'keys' => ['p256dh' => $this->device['p256dh'], 'auth' => $this->device['auth']]])->assertUnprocessable();
        $this->actingAs($this->user)->postJson('/api/push/subscriptions', ['endpoint' => 'https://fcm.googleapis.com/x', 'keys' => ['p256dh' => 'AAAA', 'auth' => $this->device['auth']]])->assertUnprocessable();
        $this->subscribe();

        $list = $this->actingAs($this->user)->getJson('/api/push/subscriptions')->assertOk()->assertJsonCount(1);
        $this->assertStringNotContainsString('fcm.googleapis.com', $list->getContent());
        $this->assertNotSame('https://fcm.googleapis.com/fcm/send/abc', PushSubscription::first()->getRawOriginal('endpoint'), 'Endpoints are encrypted at rest');

        $id = PushSubscription::first()->id;
        $this->actingAs(User::factory()->create())->deleteJson("/api/push/subscriptions/{$id}")->assertNotFound();
        $this->actingAs($this->user)->deleteJson("/api/push/subscriptions/{$id}")->assertOk();
        $this->assertSame(1, AuditLog::where('action', 'push_subscribed')->count());
        $this->assertSame(1, AuditLog::where('action', 'push_unsubscribed')->count());
    }

    public function test_push_cannot_be_enabled_without_server_configuration(): void
    {
        config(['services.webpush.public_key' => null]);
        $this->actingAs($this->user)->getJson('/api/push/config')->assertJsonPath('configured', false)->assertJsonPath('public_key', null);
        $this->actingAs($this->user)->postJson('/api/push/subscriptions', ['endpoint' => 'https://fcm.googleapis.com/x', 'keys' => ['p256dh' => $this->device['p256dh'], 'auth' => $this->device['auth']]])->assertUnprocessable();

        $response = $this->actingAs($this->user)->postJson('/api/push/test')->assertOk();
        $this->assertNull($response->json('push_status'), 'Without infrastructure the test is in-app only, never reported as pushed');
    }

    public function test_notification_preferences_are_validated(): void
    {
        $this->actingAs($this->user)->putJson('/api/settings', ['notification_channels' => ['marketing' => ['enabled' => true]]])->assertUnprocessable();
        $this->actingAs($this->user)->putJson('/api/settings', ['notification_channels' => ['calendar' => ['enabled' => true, 'push' => true]], 'event_remind_minutes' => 10])->assertOk();
        $this->assertTrue(Notifier::channels($this->user->fresh()->preferences())['calendar']['push']);
    }
}
