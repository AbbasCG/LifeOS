<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\ProviderException;
use App\Integrations\Permissions\ConnectionPermissions;
use App\Integrations\Sync\OutboundSync;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\InboxNotification;
use App\Models\SyncRun;
use App\Models\User;
use App\Services\CalendarSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class TokenRefreshLockTest extends TestCase
{
    use RefreshDatabase;

    private CalendarAccount $account;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();   // any request a test did not fake fails loudly instead of leaving the sandbox
        config(['services.google_calendar' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback']]);
        $this->account = CalendarAccount::create(['user_id' => User::factory()->create()->id, 'provider' => 'google', 'external_account_id' => 'g', 'access_token' => 'old-access', 'refresh_token' => 'old-refresh', 'token_expires_at' => now()->subMinute(), 'status' => 'active']);
    }

    private function refreshResponse(): void
    {
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['access_token' => 'new-access', 'refresh_token' => 'new-refresh', 'expires_in' => 3600])]);
    }

    public function test_an_expired_token_is_refreshed_once_and_stored(): void
    {
        $this->refreshResponse();
        $sync = app(CalendarSyncService::class);
        $this->assertSame('new-access', $sync->freshToken($this->account));
        $this->assertSame('new-access', $sync->freshToken($this->account), 'the second caller reuses it');
        Http::assertSentCount(1);
        $stored = $this->account->fresh();
        $this->assertSame(['new-access', 'new-refresh'], [$stored->access_token, $stored->refresh_token]);
        $this->assertTrue($stored->token_expires_at->isFuture());
    }

    public function test_a_caller_with_a_stale_copy_uses_what_another_process_already_stored(): void
    {
        $this->refreshResponse();
        $stale = CalendarAccount::find($this->account->id);          // loaded before the other process refreshed
        CalendarAccount::find($this->account->id)->forceFill(['access_token' => 'rotated-by-other', 'refresh_token' => 'rotated-refresh', 'token_expires_at' => now()->addHour()])->save();

        $this->assertSame('rotated-by-other', app(CalendarSyncService::class)->freshToken($stale));
        Http::assertNothingSent();   // no second refresh with a refresh token the provider may already have invalidated
    }

    public function test_a_refresh_that_cannot_get_the_lock_fails_cleanly_without_calling_the_provider(): void
    {
        $this->refreshResponse();
        config(['integrations.refresh_lock_wait' => 1]);
        $held = Cache::lock("connected-refresh:{$this->account->id}", 30);
        $this->assertTrue($held->get());
        try {
            app(CalendarSyncService::class)->freshToken($this->account);
            $this->fail('should not refresh while another process holds the lock');
        } catch (ProviderException $e) {
            $this->assertStringContainsString('Another request is refreshing', $e->getMessage());
        } finally {
            $held->release();
        }
        Http::assertNothingSent();
        $this->assertSame('old-access', $this->account->fresh()->access_token);
    }

    public function test_the_lock_is_released_after_success_and_after_failure(): void
    {
        $this->refreshResponse();
        app(CalendarSyncService::class)->freshToken($this->account);
        $lock = Cache::lock("connected-refresh:{$this->account->id}", 5);
        $this->assertTrue($lock->get(), 'free after a successful refresh');
        $lock->release();

        // A refresh the provider rejects as revoked (400 invalid_grant) is a ProviderAuthException specifically, and the lock is free afterwards.
        $this->account->forceFill(['token_expires_at' => now()->subMinute()])->save();
        Http::swap(new Factory);   // the first stub would otherwise keep matching
        Http::preventStrayRequests();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'invalid_grant'], 400)]);
        try {
            app(CalendarSyncService::class)->freshToken($this->account);
            $this->fail('invalid_grant should surface');
        } catch (ProviderAuthException) {
            $this->addToAssertionCount(1);
        }
        $again = Cache::lock("connected-refresh:{$this->account->id}", 5);
        $this->assertTrue($again->get(), 'free after a failed refresh');
        $again->release();

        // A provider outage (500) is NOT a reason to treat the access as revoked: a plain ProviderException, never the auth subclass.
        Http::swap(new Factory);
        Http::preventStrayRequests();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'server_error'], 500)]);
        try {
            app(CalendarSyncService::class)->freshToken($this->account);
            $this->fail('a 500 should surface');
        } catch (ProviderAuthException) {
            $this->fail('a 500 from the provider must not be classified as revoked access');
        } catch (ProviderException $e) {
            $this->assertNotInstanceOf(ProviderAuthException::class, $e);
        }
        $last = Cache::lock("connected-refresh:{$this->account->id}", 5);
        $this->assertTrue($last->get(), 'free after a 500');
        $last->release();
        $this->assertSame('new-access', $this->account->fresh()->access_token, 'the token stored by the earlier successful refresh is untouched by the failures');
    }

    public function test_a_refresh_answer_without_an_access_token_fails_and_leaves_the_stored_tokens_alone(): void
    {
        Http::fake(['oauth2.googleapis.com/*' => Http::response([], 200)]);
        try {
            app(CalendarSyncService::class)->freshToken($this->account);
            $this->fail('an empty 200 must not be accepted as a refreshed token');
        } catch (ProviderAuthException) {
            $this->fail('an empty answer is a provider fault, not revoked access');
        } catch (ProviderException $e) {
            $this->assertStringContainsString('did not return an access token', $e->getMessage());
        }
        $stored = $this->account->fresh();
        $this->assertSame(['old-access', 'old-refresh'], [$stored->access_token, $stored->refresh_token]);
        $this->assertTrue($stored->token_expires_at->isPast());
        $free = Cache::lock("connected-refresh:{$this->account->id}", 5);
        $this->assertTrue($free->get());
        $free->release();
    }

    // ---- a failed refresh inside the outbound run ----

    /** The account as the outbound run sees it: sending allowed, one copy that fell behind, and an expired token (setUp). */
    private function outboundReady(): CalendarWriteLink
    {
        config(['calendar_write.enabled' => true]);
        $this->account->forceFill(['sync_direction' => 'outbound', 'scopes' => 'openid calendar.readonly', 'write_granted_at' => now(), 'write_calendar_id' => 'work@group', 'write_calendar_name' => 'Work',
            'permissions' => ConnectionPermissions::PRESETS['read_create_update']])->save();
        $event = CalendarEvent::create(['user_id' => $this->account->user_id, 'title' => 'Renamed in LifeOS', 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);

        return CalendarWriteLink::create(['user_id' => $this->account->user_id, 'calendar_account_id' => $this->account->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'work@group',
            'external_id' => 'lifeos123', 'etag' => '"e1"', 'title' => 'Old title', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
    }

    private function assertNothingSentToTheCalendar(): void
    {
        Http::assertNotSent(fn ($request) => str_contains($request->url(), 'www.googleapis.com/calendar'));
    }

    public function test_a_revoked_refresh_during_an_outbound_run_revokes_the_account_and_sends_nothing(): void
    {
        $link = $this->outboundReady();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'invalid_grant'], 400)]);

        $result = app(OutboundSync::class)->run($this->account->fresh());

        $this->assertSame([true, 0], [$result['ran'], $result['pushed']]);
        $this->assertSame('revoked', $this->account->fresh()->status);
        $this->assertSame('revoked', SyncRun::where('trigger', 'outbound')->sole()->status);
        $this->assertNothingSentToTheCalendar();
        $this->assertSame('Old title', $link->fresh()->title);
        $this->assertSame(1, InboxNotification::where('user_id', $this->account->user_id)->count(), 'the person is told once to reconnect');
        $free = Cache::lock("calendar-write:{$this->account->id}", 5);
        $this->assertTrue($free->get(), 'the write lock is released');
        $free->release();
    }

    /** @return array<string, array{array<string, string>, bool}> */
    public static function transientRefreshFailures(): array
    {
        return ['503 with Retry-After' => [['Retry-After' => '90'], true], '503 without Retry-After' => [[], false]];
    }

    /**
     * A provider outage on the token refresh ends the run cleanly: a rate-limited refresh (503 with Retry-After) makes the account wait and finishes the run as rate_limited; any
     * other refresh failure (bare 503) finishes it as failed with a scrubbed error. Either way the run stops, access is NOT treated as revoked, the person is not told to
     * reconnect, nothing is sent to the calendar and no lock is left behind.
     *
     * @param  array<string, string>  $headers
     */
    #[DataProvider('transientRefreshFailures')]
    public function test_a_provider_outage_on_refresh_during_an_outbound_run_ends_the_run_without_revoking_or_notifying(array $headers, bool $rateLimited): void
    {
        $link = $this->outboundReady();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'unavailable'], 503, $headers)]);

        $result = app(OutboundSync::class)->run($this->account->fresh());

        $this->assertTrue($result['ran']);
        $this->assertSame(0, $result['pushed']);
        $account = $this->account->fresh();
        $run = SyncRun::where('trigger', 'outbound')->sole();
        $this->assertNotSame('running', $run->status, 'the run is finished, not left hanging');
        $this->assertNotEmpty($run->error);
        if ($rateLimited) {
            $this->assertSame('rate_limited', $run->status);
            $wait = $account->retry_after->getTimestamp() - now()->getTimestamp();
            $this->assertGreaterThanOrEqual(30, $wait);
            $this->assertEqualsWithDelta(90, $wait, 2, 'the provider asked for 90 seconds');
        } else {
            $this->assertSame('failed', $run->status);
            $this->assertSame(1, $result['failed']);
            $this->assertNull($account->retry_after, 'a plain failure sets no wait');
            $this->assertStringContainsString('503', $run->error);
        }
        $this->assertSame('active', $account->status, 'a provider outage is not revoked access');
        $this->assertSame(0, InboxNotification::where('user_id', $account->user_id)->count());
        $this->assertNothingSentToTheCalendar();
        $this->assertSame('Old title', $link->fresh()->title);
        foreach (["calendar-write:{$account->id}", "connected-refresh:{$account->id}"] as $key) {
            $lock = Cache::lock($key, 5);
            $this->assertTrue($lock->get(), "{$key} is free");
            $lock->release();
        }
    }

    public function test_a_rate_limited_refresh_during_an_outbound_run_makes_the_account_wait(): void
    {
        $this->outboundReady();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'unavailable'], 503, ['Retry-After' => '90'])]);

        app(OutboundSync::class)->run($this->account->fresh());

        $this->assertTrue($this->account->fresh()->retry_after->isFuture());
        $status = SyncRun::where('trigger', 'outbound')->sole()->status;
        $this->assertNotSame('running', $status);
        $this->assertSame('rate_limited', $status);
        Http::assertSentCount(1);   // the refresh only; nothing more is tried
    }

    public function test_tokens_that_never_expire_and_accounts_without_a_refresh_token_behave_as_before(): void
    {
        Http::fake();
        $todoist = CalendarAccount::create(['user_id' => $this->account->user_id, 'provider' => 'todoist', 'external_account_id' => 't', 'access_token' => 'forever', 'status' => 'active']);
        $this->assertSame('forever', app(CalendarSyncService::class)->freshToken($todoist));

        $noRefresh = CalendarAccount::create(['user_id' => $this->account->user_id, 'provider' => 'google', 'external_account_id' => 'n', 'access_token' => 'x', 'token_expires_at' => now()->subHour(), 'status' => 'active']);
        $this->expectException(ProviderAuthException::class);
        app(CalendarSyncService::class)->freshToken($noRefresh);
    }
}
