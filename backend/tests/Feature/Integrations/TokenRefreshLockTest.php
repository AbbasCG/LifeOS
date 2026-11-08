<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\ProviderException;
use App\Models\CalendarAccount;
use App\Models\User;
use App\Services\CalendarSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class TokenRefreshLockTest extends TestCase
{
    use RefreshDatabase;

    private CalendarAccount $account;

    protected function setUp(): void
    {
        parent::setUp();
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

        $this->account->forceFill(['token_expires_at' => now()->subMinute()])->save();
        Http::swap(new Factory);   // the first stub would otherwise keep matching
        Http::preventStrayRequests();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'invalid_grant'], 400)]);
        try {
            app(CalendarSyncService::class)->freshToken($this->account);
            $this->fail('invalid_grant should surface');
        } catch (ProviderAuthException|ProviderException) {
        }
        $again = Cache::lock("connected-refresh:{$this->account->id}", 5);
        $this->assertTrue($again->get(), 'free after a failed refresh');
        $again->release();
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
