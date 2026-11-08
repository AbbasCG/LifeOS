<?php

namespace Tests\Feature\Integrations;

use App\Models\AppCredential;
use App\Models\AuditLog;
use App\Models\User;
use App\Services\TwoFactorService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class IntegrationAdminTest extends TestCase
{
    use RefreshDatabase;

    private const SECRET = 'SUPER-SECRET-CLIENT-VALUE';

    private function admin(bool $twoFactor = true): User
    {
        $user = User::factory()->create();
        $user->forceFill(['is_admin' => true])->save();
        if ($twoFactor) {
            $user->forceFill(['two_factor_secret' => app(TwoFactorService::class)->generateSecret(), 'two_factor_confirmed_at' => now()])->save();
        }

        return $user;
    }

    private function payload(array $extra = []): array
    {
        return ['client_id' => 'client-123', 'client_secret' => self::SECRET] + $extra;
    }

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.frontend_url' => 'https://app.lifeos.test']);
    }

    public function test_guests_and_ordinary_users_cannot_read_or_change_credentials(): void
    {
        $this->getJson('/api/admin/integrations/credentials')->assertUnauthorized();
        $this->putJson('/api/admin/integrations/credentials/google', $this->payload())->assertUnauthorized();

        $this->actingAs(User::factory()->create());
        $this->getJson('/api/admin/integrations/credentials')->assertForbidden()->assertJsonPath('code', 'admin_required');
        $this->withSession(['auth.password_confirmed_at' => time()]);
        $this->putJson('/api/admin/integrations/credentials/google', $this->payload())->assertForbidden();
        $this->deleteJson('/api/admin/integrations/credentials/google')->assertForbidden();
        $this->assertSame(0, AppCredential::count());
    }

    public function test_the_admin_flag_cannot_be_set_through_the_api_or_mass_assignment(): void
    {
        $this->postJson('/api/register', ['name' => 'Sneaky', 'email' => 'sneaky@example.com', 'password' => 'strong-password', 'password_confirmation' => 'strong-password', 'is_admin' => true])->assertCreated();
        $this->assertFalse((bool) User::where('email', 'sneaky@example.com')->value('is_admin'));
        $this->assertFalse((bool) (new User(['name' => 'x', 'is_admin' => true]))->is_admin);
    }

    public function test_an_admin_without_two_factor_can_read_but_not_change(): void
    {
        $this->actingAs($this->admin(twoFactor: false));
        $this->getJson('/api/admin/integrations/credentials')->assertOk();
        $this->withSession(['auth.password_confirmed_at' => time()]);
        $this->putJson('/api/admin/integrations/credentials/google', $this->payload())->assertForbidden()->assertJsonPath('code', 'two_factor_required');
        $this->assertSame(0, AppCredential::count());
    }

    public function test_changes_need_a_recent_password_confirmation(): void
    {
        $this->actingAs($this->admin());
        $this->putJson('/api/admin/integrations/credentials/google', $this->payload())->assertStatus(423);
        $this->deleteJson('/api/admin/integrations/credentials/google')->assertStatus(423);
        $this->assertSame(0, AppCredential::count());
    }

    public function test_saving_stores_the_secret_encrypted_and_never_returns_it(): void
    {
        $admin = $this->admin();
        $this->actingAs($admin)->withSession(['auth.password_confirmed_at' => time()]);
        $response = $this->putJson('/api/admin/integrations/credentials/google', $this->payload(['redirect_uri' => 'https://app.lifeos.test/api/integrations/google/callback']));
        $response->assertOk()->assertJsonPath('data.source', 'database')->assertJsonPath('data.has_secret', true)->assertJsonPath('data.client_id', 'client-123');
        $this->assertStringNotContainsString(self::SECRET, $response->getContent());
        $this->assertStringNotContainsString(self::SECRET, json_encode((array) DB::table('integration_app_credentials')->first()));

        $this->getJson('/api/admin/integrations/credentials')->assertOk()->assertJsonMissingPath('data.0.client_secret');
        $this->assertStringNotContainsString(self::SECRET, $this->getJson('/api/admin/integrations/credentials')->getContent());

        $log = AuditLog::where('action', 'integration_credentials_set')->latest('id')->first();
        $this->assertSame(['provider' => 'google', 'secret_changed' => true], $log->meta);
        $this->assertStringNotContainsString('client-123', json_encode($log->meta));
        $this->assertStringNotContainsString(self::SECRET, json_encode(AuditLog::all()->toArray()));
    }

    public function test_updating_without_a_secret_keeps_the_stored_one_but_the_first_save_requires_it(): void
    {
        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        $this->putJson('/api/admin/integrations/credentials/google', ['client_id' => 'client-123'])->assertUnprocessable()->assertJsonValidationErrors('client_secret');
        $this->putJson('/api/admin/integrations/credentials/google', $this->payload())->assertOk();
        $this->putJson('/api/admin/integrations/credentials/google', ['client_id' => 'client-456'])->assertOk();
        $row = AppCredential::first();
        $this->assertSame(['client-456', self::SECRET], [$row->client_id, $row->client_secret]);
        $this->assertSame(1, AppCredential::count());
    }

    public function test_the_redirect_address_must_stay_on_this_site_and_the_provider_callback(): void
    {
        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        foreach ([
            'https://evil.example/api/integrations/google/callback',
            'https://app.lifeos.test/api/integrations/outlook/callback',
            'https://app.lifeos.test/api/integrations/google/callback?x=1',
            'http://app.lifeos.test/api/integrations/google/callback',
            'https://app.lifeos.test.evil.example/api/integrations/google/callback',
            'https://app.lifeos.test:8443/api/integrations/google/callback',
            'javascript:alert(1)',
        ] as $bad) {
            $this->putJson('/api/admin/integrations/credentials/google', $this->payload(['redirect_uri' => $bad]))->assertUnprocessable()->assertJsonValidationErrors('redirect_uri');
        }
        $this->assertSame(0, AppCredential::count());
    }

    public function test_only_available_providers_that_need_setup_can_be_configured(): void
    {
        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        foreach (['github', 'ics', 'openai', 'nope'] as $provider) {
            $this->putJson("/api/admin/integrations/credentials/{$provider}", $this->payload())->assertNotFound();
            $this->deleteJson("/api/admin/integrations/credentials/{$provider}")->assertNotFound();
        }
        $this->assertSame(0, AppCredential::count());
    }

    public function test_removing_credentials_is_audited_and_falls_back_to_the_environment(): void
    {
        config(['services.todoist' => ['client_id' => 'env-todoist', 'client_secret' => 'env-secret', 'redirect' => 'https://app.lifeos.test/api/integrations/todoist/callback']]);
        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        $this->putJson('/api/admin/integrations/credentials/todoist', $this->payload())->assertOk()->assertJsonPath('data.source', 'database');
        $this->deleteJson('/api/admin/integrations/credentials/todoist')->assertOk()->assertJsonPath('data.source', 'environment');
        $this->assertSame(1, AuditLog::where('action', 'integration_credentials_removed')->count());
        $this->assertSame(0, AppCredential::count());
    }

    public function test_make_admin_command_grants_and_revokes_and_audits(): void
    {
        $user = User::factory()->create(['email' => 'boss@example.com']);
        $this->artisan('lifeos:make-admin', ['email' => 'nobody@example.com'])->assertFailed();
        $this->artisan('lifeos:make-admin', ['email' => 'BOSS@example.com'])->assertSuccessful();
        $this->assertTrue((bool) $user->fresh()->is_admin);
        $this->artisan('lifeos:make-admin', ['email' => 'boss@example.com'])->expectsOutput('Already an administrator.')->assertSuccessful();
        $this->artisan('lifeos:make-admin', ['email' => 'boss@example.com', '--revoke' => true])->assertSuccessful();
        $this->assertFalse((bool) $user->fresh()->is_admin);
        $this->assertSame(['admin_granted', 'admin_revoked'], AuditLog::where('user_id', $user->id)->orderBy('id')->pluck('action')->all());
    }
}
