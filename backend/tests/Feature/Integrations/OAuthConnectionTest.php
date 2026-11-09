<?php

namespace Tests\Feature\Integrations;

use App\Integrations\OAuth\OAuthStateStore;
use App\Integrations\Vault\CredentialVault;
use App\Models\AppCredential;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\OauthState;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Connecting an account with the OAuth client an administrator saved on the provider configuration screen (or the legacy .env values): the state lives on the server,
 * belongs to one person and one provider, works once, and every way the flow can go wrong ends back in the app with a reason and no half-connected account.
 * Providers are faked; no test reaches Google, Microsoft or Todoist.
 */
class OAuthConnectionTest extends TestCase
{
    use RefreshDatabase;

    private const APP = 'https://app.lifeos.test';

    private const SECRET = 'VAULT-CLIENT-SECRET-VALUE';

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.frontend_url' => self::APP, 'services.google_calendar' => ['client_id' => null, 'client_secret' => null, 'redirect' => self::APP.'/api/integrations/google/callback'],
            'services.microsoft_calendar' => ['client_id' => null, 'client_secret' => null, 'tenant' => 'common', 'redirect' => self::APP.'/api/integrations/outlook/callback'],
            'services.todoist' => ['client_id' => null, 'client_secret' => null, 'redirect' => self::APP.'/api/integrations/todoist/callback']]);
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
        $this->fakeProviders();
    }

    /** The administrator's screen saved this client (the secret is encrypted by the model). */
    private function vault(string $provider = 'google', string $id = 'vault-client-id'): void
    {
        AppCredential::create(['provider_key' => $provider, 'client_id' => $id, 'client_secret' => self::SECRET, 'redirect_uri' => self::APP."/api/integrations/{$provider}/callback", 'enabled' => true]);
        $this->forgetVault();
    }

    /** A real request is a new process with empty caches; a test keeps one application between requests. */
    private function forgetVault(): void
    {
        $this->app->forgetInstance(CredentialVault::class);
        foreach ($this->app['router']->getRoutes()->getRoutes() as $route) {
            $route->flushController();
        }
    }

    private int $tokenStatus = 200;

    private function fakeProviders(): void
    {
        Http::fake([
            'oauth2.googleapis.com/token' => fn () => $this->tokenStatus === 200 ? Http::response(['access_token' => 'g-access', 'refresh_token' => 'g-refresh', 'expires_in' => 3600, 'scope' => 'calendar.readonly']) : Http::response(['error' => 'invalid_grant'], $this->tokenStatus),
            'openidconnect.googleapis.com/*' => Http::response(['sub' => 'google-user-1', 'email' => 'me@gmail.com', 'name' => 'Me']),
            'www.googleapis.com/calendar/v3/users/me/calendarList*' => Http::response(['items' => [['id' => 'primary', 'timeZone' => 'Europe/Amsterdam']]]),
            'www.googleapis.com/calendar/v3/calendars/*' => Http::response(['items' => []]),
            'oauth2.googleapis.com/revoke' => Http::response([], 200),
            'login.microsoftonline.com/*' => Http::response(['access_token' => 'm-access', 'refresh_token' => 'm-refresh', 'expires_in' => 3600, 'scope' => 'Calendars.Read']),
            'graph.microsoft.com/v1.0/me*' => Http::response(['id' => 'ms-user-1', 'mail' => 'me@outlook.test', 'displayName' => 'Me']),
            'graph.microsoft.com/*' => Http::response(['value' => []]),
            'todoist.com/oauth/access_token' => Http::response(['access_token' => 'td-token', 'token_type' => 'Bearer']),
            'api.todoist.com/api/v1/user' => Http::response(['id' => '42', 'email' => 'me@todoist.test', 'full_name' => 'Me']),
            'api.todoist.com/api/v1/projects*' => Http::response(['results' => [], 'next_cursor' => null]),
            'api.todoist.com/api/v1/sync' => Http::response(['full_sync' => true, 'sync_token' => 'st-1', 'items' => []]),
        ]);
    }

    /** @return array<string, string> the query of the address the browser is sent to */
    private function start(string $provider = 'google'): array
    {
        $url = $this->postJson("/api/integrations/{$provider}/connect")->assertOk()->json('authorization_url');
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        return $query;
    }

    private function returnFrom(string $provider, string $query): TestResponse
    {
        return $this->get("/api/integrations/{$provider}/callback?{$query}");
    }

    private function backTo(string $param): string
    {
        return self::APP.'/settings/integrations?'.$param;
    }

    // ---- the client comes from the provider configuration, or from .env as before ----

    public function test_the_authorization_address_and_token_exchange_use_the_saved_client_and_never_show_the_secret(): void
    {
        $this->vault();
        $query = $this->start();
        $this->assertSame('vault-client-id', $query['client_id']);
        $this->assertSame(self::APP.'/api/integrations/google/callback', $query['redirect_uri']);
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        Http::assertSent(fn (HttpRequest $r) => $r->url() === 'https://oauth2.googleapis.com/token' && $r['client_id'] === 'vault-client-id' && $r['client_secret'] === self::SECRET && $r['redirect_uri'] === self::APP.'/api/integrations/google/callback');
        $this->assertStringNotContainsString(self::SECRET, (string) $this->getJson('/api/integrations')->getContent());
        $this->assertStringNotContainsString(self::SECRET, (string) $this->getJson('/api/integrations/catalog')->getContent());
    }

    public function test_the_legacy_environment_client_keeps_working_and_the_saved_one_wins_when_both_exist(): void
    {
        config(['services.google_calendar.client_id' => 'env-id', 'services.google_calendar.client_secret' => 'env-secret']);
        $this->assertSame('env-id', $this->start()['client_id']);
        $this->vault();
        $this->assertSame('vault-client-id', $this->start()['client_id']);
        AppCredential::query()->delete();
        $this->forgetVault();
        $this->assertSame('env-id', $this->start()['client_id'], 'removing the saved client brings the environment values back');
    }

    public function test_a_provider_without_a_client_cannot_be_started_and_says_why(): void
    {
        $this->postJson('/api/integrations/google/connect')->assertUnprocessable()->assertJsonValidationErrors('provider');
        $this->assertSame(0, OauthState::count(), 'nothing is prepared for a provider that cannot be used');
    }

    public function test_a_switched_off_provider_cannot_be_started_and_a_flow_in_progress_ends_with_a_reason(): void
    {
        $this->vault();
        $query = $this->start();
        AppCredential::where('provider_key', 'google')->update(['connections_blocked_at' => now()]);
        $this->forgetVault();
        $this->postJson('/api/integrations/google/connect')->assertUnprocessable();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('error=provider_disabled&provider=google'));
        $this->assertSame(0, CalendarAccount::count());
        Http::assertNotSent(fn (HttpRequest $r) => str_contains($r->url(), 'oauth2.googleapis.com/token'));
    }

    public function test_a_client_removed_while_the_person_was_signing_in_ends_with_a_reason(): void
    {
        $this->vault();
        $query = $this->start();
        AppCredential::query()->delete();
        $this->forgetVault();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('error=not_configured&provider=google'));
        $this->assertSame(0, CalendarAccount::count());
    }

    // ---- the state ----

    public function test_the_state_is_kept_on_the_server_hashed_and_bound_to_this_person_and_provider(): void
    {
        $this->vault();
        $query = $this->start();
        $row = OauthState::firstOrFail();
        $this->assertSame([$this->user->id, 'google'], [$row->user_id, $row->provider]);
        $this->assertSame(hash('sha256', $query['state']), $row->state_hash);
        $this->assertNotSame($query['state'], $row->state_hash);
        $this->assertStringNotContainsString($row->verifier, (string) json_encode((array) DB::table('oauth_states')->first()), 'the PKCE verifier is encrypted at rest');
        $this->assertSame(OAuthStateStore::challenge($row->verifier), $query['code_challenge']);
        $this->assertSame('S256', $query['code_challenge_method']);
        $this->assertSame(43, strlen($query['state']));
        $this->assertNull(session()->get('oauth.'.$query['state']), 'nothing about the flow lives in the browser session any more');
    }

    public function test_a_forged_missing_expired_and_replayed_state_are_all_refused(): void
    {
        $this->vault();
        $this->returnFrom('google', 'code=c&state=forged')->assertRedirect($this->backTo('error=state'));
        $this->returnFrom('google', 'code=c')->assertRedirect($this->backTo('error=state'));
        $this->returnFrom('google', 'error=access_denied')->assertRedirect($this->backTo('error=state'));

        $expired = $this->start();
        $this->travel(601)->seconds();
        $this->returnFrom('google', 'code=c&state='.$expired['state'])->assertRedirect($this->backTo('error=state'));
        $this->travelBack();

        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('error=state'));
        $this->assertSame(1, CalendarAccount::count(), 'the replay created nothing');
        $this->assertCount(1, Http::recorded(fn (HttpRequest $r) => $r->url() === 'https://oauth2.googleapis.com/token'), 'the code was exchanged once');
    }

    public function test_another_person_or_another_provider_cannot_use_a_state_and_does_not_end_it(): void
    {
        $this->vault();
        $this->vault('outlook', 'ms-id');
        $query = $this->start();
        $attacker = User::factory()->create();

        $this->actingAs($attacker);
        $this->returnFrom('google', 'code=attacker-code&state='.$query['state'])->assertRedirect($this->backTo('error=state'));
        $this->assertSame(0, CalendarAccount::count(), 'nothing was connected for the attacker');
        $this->assertSame(0, CalendarAccount::where('user_id', $attacker->id)->count());

        $this->actingAs($this->user);
        $this->returnFrom('outlook', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('error=state'));
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $this->assertSame($this->user->id, CalendarAccount::firstOrFail()->user_id);
    }

    public function test_a_callback_without_a_session_is_refused_and_cannot_use_the_state(): void
    {
        $this->vault();
        $query = $this->start();
        // A new request with no sign-in: the guard forgets the person the test acted as, and the session is empty. The route stays behind sign-in
        // (RouteSecurityTest forbids a redirect for guests on protected routes), so nothing is connected and the state is not spent.
        $this->app['auth']->forgetGuards();
        $this->flushSession();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertUnauthorized();
        $this->assertSame(0, CalendarAccount::count());
        $this->assertNull(OauthState::firstOrFail()->consumed_at, 'a request with no person cannot use the state');
    }

    public function test_the_callback_never_redirects_anywhere_but_the_app(): void
    {
        $this->vault();
        $query = $this->start();
        $response = $this->returnFrom('google', 'code=c&state='.$query['state'].'&redirect_uri=https://evil.test&return_to=//evil.test&next=https://evil.test&redirect=https://evil.test');
        $response->assertRedirect($this->backTo('connected=google'));
        $this->assertStringNotContainsString('evil', (string) $response->headers->get('Location'));
        $this->assertNull(OAuthStateStore::safeReturnTo('//evil.test'));
        $this->assertNull(OAuthStateStore::safeReturnTo('https://evil.test'));
        $this->assertNull(OAuthStateStore::safeReturnTo('/\\evil.test'));
    }

    // ---- cancel and failure ----

    public function test_cancelling_at_the_provider_connects_nothing_and_ends_the_state(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'error=access_denied&error_description=hidden&state='.$query['state'])->assertRedirect($this->backTo('error=denied'));
        $this->assertSame(0, CalendarAccount::count());
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('error=state'));
        Http::assertNotSent(fn (HttpRequest $r) => str_contains($r->url(), '/token'));
    }

    public function test_a_failed_token_exchange_connects_nothing_and_leaks_nothing(): void
    {
        $this->vault();
        $this->tokenStatus = 400;
        $query = $this->start();
        $response = $this->returnFrom('google', 'code=bad&state='.$query['state']);
        $response->assertRedirect($this->backTo('error=exchange'));
        $this->assertStringNotContainsString(self::SECRET, (string) $response->headers->get('Location'));
        $this->assertSame(0, CalendarAccount::count());
    }

    // ---- what is stored ----

    public function test_tokens_are_encrypted_at_rest_and_never_returned(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $raw = DB::table('calendar_accounts')->first();
        $this->assertStringNotContainsString('g-access', (string) $raw->access_token);
        $this->assertStringNotContainsString('g-refresh', (string) $raw->refresh_token);
        $this->assertSame('g-access', CalendarAccount::firstOrFail()->access_token);
        $body = (string) $this->getJson('/api/integrations')->getContent().(string) $this->getJson('/api/integrations/catalog')->getContent();
        $this->assertStringNotContainsString('g-access', $body);
        $this->assertStringNotContainsString('g-refresh', $body);
        $this->assertTrue(AuditLog::where(['user_id' => $this->user->id, 'action' => 'integration_connected'])->exists());
    }

    public function test_reconnecting_updates_the_same_account_and_clears_a_revoked_state(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $account = CalendarAccount::firstOrFail();
        $account->forceFill(['status' => 'revoked', 'last_error' => 'Access was revoked'])->save();

        $again = $this->start();
        $this->returnFrom('google', 'code=c2&state='.$again['state'])->assertRedirect($this->backTo('connected=google'));
        $this->assertSame(1, CalendarAccount::count(), 'no duplicate account');
        $fresh = $account->fresh();
        $this->assertSame('active', $fresh->status);
        $this->assertNull($fresh->last_error);
    }

    public function test_disconnecting_revokes_where_the_provider_supports_it_removes_the_account_and_is_private(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $account = CalendarAccount::firstOrFail();

        $this->actingAs(User::factory()->create());
        $this->deleteJson("/api/integrations/accounts/{$account->id}")->assertNotFound();
        $this->assertSame(1, CalendarAccount::count(), 'another person cannot disconnect it');

        $this->actingAs($this->user);
        $this->deleteJson("/api/integrations/accounts/{$account->id}")->assertSuccessful();
        $this->assertSame(0, CalendarAccount::count());
        Http::assertSent(fn (HttpRequest $r) => $r->url() === 'https://oauth2.googleapis.com/revoke' && $r['token'] === 'g-refresh');
        $this->assertTrue(AuditLog::where(['user_id' => $this->user->id, 'action' => 'integration_disconnected'])->exists());
    }

    public function test_disconnecting_succeeds_even_when_the_provider_cannot_be_reached(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        Http::fake(['oauth2.googleapis.com/revoke' => Http::response('down', 500)]);
        $this->deleteJson('/api/integrations/accounts/'.CalendarAccount::firstOrFail()->id)->assertSuccessful();
        $this->assertSame(0, CalendarAccount::count(), 'our copy of the tokens is removed whatever the provider answers');
    }

    // ---- what a new connection may do ----

    public function test_a_new_connection_starts_with_the_least_it_may_do_and_a_reconnect_keeps_the_persons_choice(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $account = CalendarAccount::firstOrFail();
        $this->assertSame(['read', 'sync'], $account->permissions, 'reading and syncing only: nothing is ever sent to the provider until the person turns it on');
        $this->assertNotNull($account->permissions_changed_at);

        $account->forceFill(['permissions' => ['read']])->save();   // the person switched background syncing off
        $again = $this->start();
        $this->returnFrom('google', 'code=c2&state='.$again['state'])->assertRedirect($this->backTo('connected=google'));
        $this->assertSame(['read'], $account->fresh()->permissions, 'reconnecting does not reset the choice');
    }

    // ---- the providers differ ----

    public function test_microsoft_uses_pkce_and_its_own_endpoints(): void
    {
        $this->vault('outlook', 'ms-id');
        $query = $this->start('outlook');
        $this->assertSame('S256', $query['code_challenge_method']);
        $this->assertSame('ms-id', $query['client_id']);
        $this->returnFrom('outlook', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=outlook'));
        Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'login.microsoftonline.com') && str_ends_with($r->url(), '/oauth2/v2.0/token') && strlen((string) $r['code_verifier']) === 64);
        $this->assertSame('ms-user-1', CalendarAccount::firstOrFail()->external_account_id);
    }

    public function test_todoist_has_no_pkce_so_none_is_promised_or_sent_but_the_state_still_protects_the_flow(): void
    {
        $this->vault('todoist', 'td-id');
        $query = $this->start('todoist');
        $this->assertArrayNotHasKey('code_challenge', $query, 'Todoist does not support PKCE');
        $this->assertSame('data:read', $query['scope']);
        $this->returnFrom('todoist', 'code=bad&state=forged')->assertRedirect($this->backTo('error=state'));
        $this->returnFrom('todoist', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=todoist'));
        Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'todoist.com/oauth/access_token') && ! isset($r['code_verifier']));
    }

    public function test_google_calendar_and_google_tasks_are_configured_separately(): void
    {
        $this->vault('google', 'calendar-client');
        $this->postJson('/api/integrations/google_tasks/connect')->assertUnprocessable();   // one saved client does not silently serve the other provider
        $this->vault('google_tasks', 'tasks-client');
        $query = $this->start('google_tasks');
        $this->assertSame('tasks-client', $query['client_id']);
        $this->assertSame(self::APP.'/api/integrations/google_tasks/callback', $query['redirect_uri']);
    }

    // ---- the write consent shares the same state ----

    public function test_the_write_consent_state_names_the_account_and_cannot_be_used_by_somebody_else(): void
    {
        $this->vault();
        $query = $this->start();
        $this->returnFrom('google', 'code=c&state='.$query['state'])->assertRedirect($this->backTo('connected=google'));
        $account = CalendarAccount::firstOrFail();
        $flow = app(OAuthStateStore::class)->begin($this->user, 'google', '/settings/integrations', $account->id);
        $this->assertSame($account->id, OauthState::where('state_hash', hash('sha256', $flow['state']))->firstOrFail()->account_id);

        $this->actingAs(User::factory()->create());
        $this->assertNull(app(OAuthStateStore::class)->consume($flow['state'], auth()->user(), 'google'));
        $this->actingAs($this->user);
        $this->assertSame($account->id, app(OAuthStateStore::class)->consume($flow['state'], $this->user, 'google')['account_id']);
    }

    // ---- what an ordinary person is shown ----

    public function test_setup_details_are_for_administrators_only(): void
    {
        config(['services.google_calendar.client_id' => null]);
        $google = collect($this->getJson('/api/integrations')->assertOk()->json('providers'))->firstWhere('provider', 'google');
        $this->assertFalse($google['configured']);
        $this->assertSame([], $google['env_keys']);
        $this->assertNull($google['redirect_uri']);

        $admin = User::factory()->create();
        $admin->forceFill(['is_admin' => true])->save();
        $this->actingAs($admin);
        $google = collect($this->getJson('/api/integrations')->json('providers'))->firstWhere('provider', 'google');
        $this->assertNotEmpty($google['env_keys']);
        $this->assertSame(self::APP.'/api/integrations/google/callback', $google['redirect_uri']);
    }
}
