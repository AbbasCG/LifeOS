<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Vault\CredentialVault;
use App\Models\AppCredential;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\User;
use App\Services\TwoFactorService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * The provider configuration screen's server side: the switch for new connections, the offline configuration test, the audit list and the facts the
 * screen shows (suggested redirect address, last change). No test here reaches a provider, and none may see a secret in any answer.
 */
class ProviderConfigurationTest extends TestCase
{
    use RefreshDatabase;

    private const SECRET = 'TOP-SECRET-CLIENT-VALUE';

    private const REDIRECT = 'https://app.lifeos.test/api/integrations/google/callback';

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.frontend_url' => 'https://app.lifeos.test']);
    }

    private function admin(bool $twoFactor = true): User
    {
        $user = User::factory()->create(['name' => 'Ada Admin']);
        $user->forceFill(['is_admin' => true])->save();
        if ($twoFactor) {
            $user->forceFill(['two_factor_secret' => app(TwoFactorService::class)->generateSecret(), 'two_factor_confirmed_at' => now()])->save();
        }

        return $user;
    }

    private function asAdmin(): User
    {
        $admin = $this->admin();
        $this->actingAs($admin)->withSession(['auth.password_confirmed_at' => time()]);

        return $admin;
    }

    private function save(array $extra = []): void
    {
        $this->putJson('/api/admin/integrations/credentials/google', $extra + ['client_id' => 'client-123', 'client_secret' => self::SECRET, 'redirect_uri' => self::REDIRECT])->assertOk();
    }

    /** A real request is a new process with empty caches; a test keeps one application between requests, so the vault (and the controllers holding it) is reset by hand. */
    private function newProcess(): void
    {
        $this->app->forgetInstance(CredentialVault::class);
        foreach ($this->app['router']->getRoutes()->getRoutes() as $route) {
            $route->flushController();
        }
    }

    private function assertNoSecret(string $body): void
    {
        $this->assertStringNotContainsString(self::SECRET, $body);
    }

    public function test_only_administrators_reach_the_new_routes(): void
    {
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertUnauthorized();
        $this->postJson('/api/admin/integrations/credentials/google/test')->assertUnauthorized();
        $this->getJson('/api/admin/integrations/audit')->assertUnauthorized();

        $this->actingAs(User::factory()->create())->withSession(['auth.password_confirmed_at' => time()]);
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertForbidden()->assertJsonPath('code', 'admin_required');
        $this->postJson('/api/admin/integrations/credentials/google/test')->assertForbidden();
        $this->getJson('/api/admin/integrations/audit')->assertForbidden();
        $this->assertSame(0, AppCredential::count());
    }

    public function test_changes_need_two_factor_and_the_switch_a_recent_password_confirmation(): void
    {
        $this->actingAs($this->admin(twoFactor: false))->withSession(['auth.password_confirmed_at' => time()]);
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertForbidden()->assertJsonPath('code', 'two_factor_required');
        $this->postJson('/api/admin/integrations/credentials/google/test')->assertForbidden()->assertJsonPath('code', 'two_factor_required');
        $this->getJson('/api/admin/integrations/audit')->assertOk();

        $this->actingAs($this->admin());
        $this->flushSession();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertStatus(423);
        $this->assertSame(0, AppCredential::count());
    }

    public function test_the_list_carries_what_the_screen_needs_and_never_a_secret(): void
    {
        $admin = $this->asAdmin();
        $before = $this->getJson('/api/admin/integrations/credentials')->assertOk()->json('data');
        $google = collect($before)->firstWhere('provider', 'google');
        $this->assertSame(self::REDIRECT, $google['suggested_redirect_uri']);
        $this->assertTrue($google['connections_allowed']);
        $this->assertNull($google['updated_at']);
        $this->assertNotEmpty($google['docs_url']);
        $this->assertNotEmpty($google['scopes']);
        $this->assertFalse(collect($before)->contains('provider', 'ics'), 'a feed has no OAuth client to configure');

        $this->save();
        $after = collect($this->getJson('/api/admin/integrations/credentials')->assertOk()->json('data'))->firstWhere('provider', 'google');
        $this->assertNotNull($after['updated_at']);
        $this->assertSame($admin->name, $after['updated_by']);
        $this->assertSame('database', $after['source']);
        $this->assertNoSecret((string) $this->getJson('/api/admin/integrations/credentials')->getContent());
    }

    public function test_switching_a_provider_off_blocks_new_connections_only_and_is_audited_once(): void
    {
        $this->asAdmin();
        $this->save();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk()->assertJsonPath('data.connections_allowed', false);
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();
        $this->assertSame(1, AuditLog::where('action', 'integration_provider_disabled')->count(), 'a repeat that changes nothing is not logged');
        $this->assertSame(['provider' => 'google'], AuditLog::where('action', 'integration_provider_disabled')->firstOrFail()->meta);

        $member = User::factory()->create();
        $this->actingAs($member);
        $this->postJson('/api/integrations/google/connect')->assertUnprocessable()->assertJsonValidationErrors('provider');
        $google = collect($this->getJson('/api/integrations')->assertOk()->json('providers'))->firstWhere('provider', 'google');
        $this->assertSame('disabled', $google['status']);
        $this->assertSame('disabled', collect($this->getJson('/api/integrations/catalog')->json('data.providers'))->firstWhere('id', 'google')['state']);

        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => true])->assertOk()->assertJsonPath('data.connections_allowed', true);
        $this->assertSame(1, AuditLog::where('action', 'integration_provider_enabled')->count());
        $this->actingAs($member);
        $this->postJson('/api/integrations/google/connect')->assertOk()->assertJsonStructure(['authorization_url']);
    }

    public function test_switching_off_does_not_break_connected_accounts_or_the_stored_credentials(): void
    {
        $this->asAdmin();
        $this->save();
        $user = User::factory()->create();
        CalendarAccount::create(['user_id' => $user->id, 'provider' => 'google', 'external_account_id' => 'g-1', 'email' => 'a@example.test', 'access_token' => 'tok', 'refresh_token' => 'ref',
            'token_expires_at' => now()->addHour(), 'status' => 'active', 'collections' => [], 'scopes_ok' => true]);
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();

        $overlay = app(CredentialVault::class)->overlay('google_calendar', []);
        $this->assertSame('client-123', $overlay['client_id'], 'refreshing tokens of connected accounts still has its client');
        $this->assertSame(self::SECRET, $overlay['client_secret']);
        $this->actingAs($user);
        $this->assertSame('connected', collect($this->getJson('/api/integrations/catalog')->json('data.providers'))->firstWhere('id', 'google')['state']);
    }

    public function test_a_provider_configured_through_the_environment_can_be_switched_off_without_copying_anything(): void
    {
        config(['services.google_calendar' => ['client_id' => 'env-id', 'client_secret' => 'env-secret', 'redirect' => self::REDIRECT]]);
        $this->asAdmin();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk()->assertJsonPath('data.source', 'environment');
        $row = AppCredential::firstOrFail();
        $this->assertNull($row->client_id);
        $this->assertNull($row->getRawOriginal('client_secret'), 'the environment secret is never copied into the database');
        $this->actingAs(User::factory()->create());
        $this->postJson('/api/integrations/google/connect')->assertUnprocessable();
    }

    public function test_removing_credentials_keeps_a_switched_off_provider_switched_off(): void
    {
        $this->asAdmin();
        $this->save();
        $this->deleteJson('/api/admin/integrations/credentials/google')->assertOk();
        $this->assertSame(0, AppCredential::count(), 'an enabled provider\'s row is deleted as before');

        $this->save();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();
        $this->deleteJson('/api/admin/integrations/credentials/google')->assertOk()->assertJsonPath('data.source', 'none')->assertJsonPath('data.connections_allowed', false);
        $row = AppCredential::firstOrFail();
        $this->assertNull($row->client_id);
        $this->assertNull($row->getRawOriginal('client_secret'));
        $this->assertSame(2, AuditLog::where('action', 'integration_credentials_removed')->count(), 'both removals are logged');
    }

    public function test_saving_again_does_not_silently_switch_a_provider_back_on(): void
    {
        $this->asAdmin();
        $this->save();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();
        $this->save(['client_id' => 'client-456']);
        $this->assertNotNull(AppCredential::firstOrFail()->connections_blocked_at);
        $this->assertTrue((bool) AppCredential::firstOrFail()->enabled);
    }

    public function test_the_test_checks_the_configuration_offline_and_reports_each_part(): void
    {
        $this->asAdmin();
        $none = $this->postJson('/api/admin/integrations/credentials/google/test')->assertOk()->json('data');
        $this->assertFalse($none['ok']);
        $this->assertFalse($none['contacted_provider']);
        $this->assertSame(['client_id' => false, 'secret_readable' => false, 'redirect_matches' => false, 'sign_in_address' => false, 'connections_allowed' => true], array_column($none['checks'], 'ok', 'id'));

        $this->save();
        $good = $this->postJson('/api/admin/integrations/credentials/google/test')->assertOk()->json('data');
        $this->assertTrue($good['ok']);
        $this->assertSame([true, true, true, true, true], array_column($good['checks'], 'ok'));
        $this->assertNoSecret(json_encode($good));
        $this->assertStringNotContainsString('client-123', json_encode($good));
        $this->assertSame(['provider' => 'google', 'ok' => true], AuditLog::where('action', 'integration_config_tested')->latest('id')->firstOrFail()->meta);
    }

    public function test_the_test_notices_a_redirect_address_that_is_not_the_expected_one(): void
    {
        $this->asAdmin();
        $this->save(['redirect_uri' => null]);
        config(['services.google_calendar.redirect' => 'https://elsewhere.example/api/integrations/google/callback']);
        $result = $this->postJson('/api/admin/integrations/credentials/google/test')->assertOk()->json('data');
        $this->assertFalse(array_column($result['checks'], 'ok', 'id')['redirect_matches']);
        $this->assertFalse($result['ok']);
    }

    public function test_the_test_notices_a_secret_that_can_no_longer_be_read_and_never_fails_with_an_error(): void
    {
        $this->asAdmin();
        $this->save();
        DB::table('integration_app_credentials')->update(['client_secret' => 'not-a-valid-payload']);
        $this->newProcess();
        $result = $this->postJson('/api/admin/integrations/credentials/google/test')->assertOk()->json('data');
        $this->assertFalse(array_column($result['checks'], 'ok', 'id')['secret_readable']);
        $this->assertStringNotContainsString('not-a-valid-payload', json_encode($result));
        // The screen still loads, and says the secret must be entered again.
        $listed = collect($this->getJson('/api/admin/integrations/credentials')->assertOk()->json('data'))->firstWhere('provider', 'google');
        $this->assertTrue($listed['secret_unreadable']);
        $this->assertStringNotContainsString('not-a-valid-payload', (string) $this->getJson('/api/admin/integrations/credentials')->getContent());
        // A new secret repairs it.
        $this->save(['client_secret' => 'a-new-secret']);
        $this->newProcess();
        $this->assertFalse(collect($this->getJson('/api/admin/integrations/credentials')->json('data'))->firstWhere('provider', 'google')['secret_unreadable']);
        $this->assertTrue($this->postJson('/api/admin/integrations/credentials/google/test')->json('data.ok'));
    }

    public function test_the_test_reports_a_switched_off_provider(): void
    {
        $this->asAdmin();
        $this->save();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();
        $result = $this->postJson('/api/admin/integrations/credentials/google/test')->assertOk()->json('data');
        $this->assertFalse(array_column($result['checks'], 'ok', 'id')['connections_allowed']);
    }

    public function test_only_providers_that_need_setup_can_be_switched_or_tested(): void
    {
        $this->asAdmin();
        foreach (['ics', 'notion', 'nope', 'google-calendar'] as $provider) {
            $this->patchJson("/api/admin/integrations/credentials/{$provider}/enabled", ['enabled' => false])->assertNotFound();
            $this->postJson("/api/admin/integrations/credentials/{$provider}/test")->assertNotFound();
        }
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', [])->assertUnprocessable();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => 'maybe'])->assertUnprocessable();
        $this->assertSame(0, AppCredential::count());
    }

    public function test_the_audit_list_shows_who_did_what_to_which_provider_and_nothing_secret(): void
    {
        $admin = $this->asAdmin();
        $this->save();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();
        $this->postJson('/api/admin/integrations/credentials/google/test')->assertOk();
        AuditLog::create(['user_id' => $admin->id, 'action' => 'login', 'ip_address' => '203.0.113.9', 'user_agent' => 'x']);

        $response = $this->getJson('/api/admin/integrations/audit')->assertOk();
        $rows = $response->json('data');
        $this->assertSame(['integration_config_tested', 'integration_provider_disabled', 'integration_credentials_set'], array_column($rows, 'action'), 'newest first, only provider configuration entries');
        $this->assertSame(['Ada Admin', 'google'], [$rows[2]['actor'], $rows[2]['provider']]);
        $this->assertTrue($rows[2]['secret_changed']);
        foreach ([self::SECRET, 'client-123', '203.0.113.9', self::REDIRECT] as $leak) {
            $this->assertStringNotContainsString($leak, (string) $response->getContent());
        }
    }

    public function test_an_ordinary_user_learns_nothing_about_the_switch_except_that_the_provider_is_off(): void
    {
        $this->asAdmin();
        $this->save();
        $this->patchJson('/api/admin/integrations/credentials/google/enabled', ['enabled' => false])->assertOk();
        $this->actingAs(User::factory()->create());
        $body = (string) $this->getJson('/api/integrations/catalog')->getContent().(string) $this->getJson('/api/integrations')->getContent();
        foreach ([self::SECRET, 'client-123', 'Ada Admin', 'updated_by'] as $leak) {
            $this->assertStringNotContainsString($leak, $body);
        }
    }
}
