<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Vault\CredentialVault;
use App\Models\AppCredential;
use App\Models\CalendarAccount;
use App\Models\User;
use Illuminate\Encryption\Encrypter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class CredentialVaultTest extends TestCase
{
    use RefreshDatabase;

    private function envGoogle(?string $id = 'env-id', ?string $secret = 'env-secret'): void
    {
        config(['services.google_calendar' => ['client_id' => $id, 'client_secret' => $secret, 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback']]);
    }

    public function test_the_secret_is_encrypted_at_rest_and_hidden_everywhere(): void
    {
        $admin = User::factory()->create();
        app(CredentialVault::class)->store('google', 'db-client-id', 'TOP-SECRET-VALUE', null, $admin);

        $raw = (array) DB::table('integration_app_credentials')->first();
        $this->assertStringNotContainsString('TOP-SECRET-VALUE', json_encode($raw));
        $this->assertSame('TOP-SECRET-VALUE', Crypt::decryptString($raw['client_secret']));
        $this->assertArrayNotHasKey('client_secret', AppCredential::first()->toArray());
        $this->assertStringNotContainsString('TOP-SECRET-VALUE', json_encode(app(CredentialVault::class)->status('google')));
    }

    public function test_database_credentials_win_over_the_environment_and_are_never_mixed(): void
    {
        $this->envGoogle();
        $vault = app(CredentialVault::class);
        $this->assertSame('environment', $vault->source('google'));
        $this->assertSame('env-id', $vault->overlay('google_calendar', config('services.google_calendar'))['client_id']);

        $vault->store('google', 'db-id', 'db-secret', null, User::factory()->create());
        $merged = $vault->overlay('google_calendar', config('services.google_calendar'));
        $this->assertSame(['db-id', 'db-secret'], [$merged['client_id'], $merged['client_secret']]);
        $this->assertSame('https://app.lifeos.test/api/integrations/google/callback', $merged['redirect'], 'the default redirect is kept when none was set');
        $this->assertSame('database', $vault->source('google'));

        $vault->forget('google');
        $this->assertSame('environment', $vault->source('google'));
        $this->assertSame('env-id', $vault->overlay('google_calendar', config('services.google_calendar'))['client_id']);
    }

    public function test_an_incomplete_database_row_never_borrows_the_other_half_from_the_environment(): void
    {
        $this->envGoogle();
        AppCredential::create(['provider_key' => 'google', 'client_id' => 'only-an-id']);
        $merged = app(CredentialVault::class)->overlay('google_calendar', config('services.google_calendar'));
        $this->assertSame(['env-id', 'env-secret'], [$merged['client_id'], $merged['client_secret']]);
    }

    public function test_the_secret_is_kept_when_only_the_client_id_is_updated(): void
    {
        $vault = app(CredentialVault::class);
        $admin = User::factory()->create();
        $vault->store('google', 'one', 'first-secret', null, $admin);
        $vault->store('google', 'two', null, null, $admin);
        $row = AppCredential::first();
        $this->assertSame(['two', 'first-secret'], [$row->client_id, $row->client_secret]);
    }

    public function test_a_provider_with_nothing_configured_reports_none(): void
    {
        $this->envGoogle(null, null);
        $status = app(CredentialVault::class)->status('google');
        $this->assertSame(['none', false], [$status['source'], $status['configured']]);
        $this->assertSame('none', app(CredentialVault::class)->source('unknown_provider'));
    }

    public function test_the_oauth_providers_really_use_the_database_credentials(): void
    {
        $this->envGoogle(null, null);
        config(['app.frontend_url' => 'https://app.lifeos.test']);
        $this->assertFalse(app(CalendarProviders::class)->get('google')->isConfigured());
        app(CredentialVault::class)->store('google', 'db-client-id', 'db-secret', null, User::factory()->create());
        $provider = app(CalendarProviders::class)->get('google');
        $this->assertTrue($provider->isConfigured());
        $user = User::factory()->create();
        $this->actingAs($user)->postJson('/api/integrations/google/connect')->assertOk()
            ->assertJsonPath('authorization_url', fn (string $url) => str_contains($url, 'client_id=db-client-id') && str_contains($url, 'code_challenge_method=S256'));
    }

    public function test_reencrypt_moves_secrets_to_the_new_key_and_reports_what_it_cannot_read(): void
    {
        $oldKey = config('app.key');
        $new = random_bytes(32);
        $user = User::factory()->create();
        app(CredentialVault::class)->store('google', 'id', 'rotate-me', null, $user);
        $account = CalendarAccount::create(['user_id' => $user->id, 'provider' => 'google', 'external_account_id' => 'g', 'access_token' => 'access-token-1', 'refresh_token' => 'refresh-token-1', 'status' => 'active']);
        DB::table('webhook_endpoints')->insert(['public_id' => '11111111-1111-4111-8111-111111111111', 'provider_key' => 'custom', 'name' => 'x', 'secret' => 'not-encrypted-garbage', 'created_at' => now(), 'updated_at' => now()]);

        // Rotate APP_KEY: the old key is still accepted for reading.
        config(['app.key' => 'base64:'.base64_encode($new), 'app.previous_keys' => [$oldKey]]);
        $this->app->forgetInstance('encrypter');
        Crypt::clearResolvedInstance('encrypter');
        $this->assertSame('rotate-me', AppCredential::first()->client_secret, 'readable through APP_PREVIOUS_KEYS before re-encryption');

        $this->artisan('lifeos:integrations:reencrypt')->assertFailed();   // the garbage webhook secret cannot be read
        $onlyNew = new Encrypter($new, config('app.cipher'));
        $this->assertSame('rotate-me', $onlyNew->decryptString(DB::table('integration_app_credentials')->value('client_secret')));
        $this->assertSame('access-token-1', $onlyNew->decryptString(DB::table('calendar_accounts')->where('id', $account->id)->value('access_token')));
        $this->assertSame('not-encrypted-garbage', DB::table('webhook_endpoints')->value('secret'), 'unreadable values are left untouched');
    }
}
