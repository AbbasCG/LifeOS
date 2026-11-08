<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Vault\CredentialVault;
use App\Models\CalendarAccount;
use App\Models\SyncRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class IntegrationCatalogTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.frontend_url' => 'https://app.lifeos.test']);
        foreach (['google_calendar', 'microsoft_calendar', 'google_tasks', 'microsoft_todo', 'todoist'] as $key) {
            config(["services.{$key}" => ['client_id' => null, 'client_secret' => null, 'redirect' => '']]);
        }
        $this->user = User::factory()->create();
    }

    /** @return array<string, mixed> the provider entry */
    private function provider(string $id): array
    {
        $providers = collect($this->actingAs($this->user)->getJson('/api/integrations/catalog')->assertOk()->json('data.providers'));

        return $providers->firstWhere('id', $id);
    }

    private function account(string $provider, array $extra = [], ?User $owner = null): CalendarAccount
    {
        return CalendarAccount::create(array_merge(['user_id' => ($owner ?? $this->user)->id, 'provider' => $provider, 'external_account_id' => $provider.'-'.uniqid(), 'email' => 'me@example.com', 'access_token' => 'SECRET-ACCESS', 'refresh_token' => 'SECRET-REFRESH', 'token_expires_at' => now()->addHour(), 'status' => 'active'], $extra));
    }

    public function test_guests_are_refused(): void
    {
        $this->getJson('/api/integrations/catalog')->assertUnauthorized();
    }

    public function test_every_manifest_is_listed_with_honest_states_and_no_secrets(): void
    {
        $response = $this->actingAs($this->user)->getJson('/api/integrations/catalog')->assertOk();
        $this->assertCount(14, $response->json('data.providers'));
        $this->assertSame('calendars', $response->json('data.categories.0.key'));
        $this->assertFalse($response->json('data.can_manage'));
        $this->assertStringNotContainsString('SECRET', $response->getContent());
        $this->assertSame('planned', $this->provider('github')['state']);
        $this->assertFalse($this->provider('github')['setup_ready']);
    }

    public function test_an_oauth_provider_without_credentials_requires_setup_and_is_never_shown_connected(): void
    {
        $google = $this->provider('google');
        $this->assertSame(['requires_setup', false, []], [$google['state'], $google['setup_ready'], $google['accounts']]);
        $this->assertSame('disconnected', $this->provider('ics')['state'], 'a feed needs no administrator setup');
    }

    public function test_environment_credentials_make_a_provider_ready_and_database_credentials_do_too(): void
    {
        config(['services.todoist' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x']]);
        $this->assertSame(['disconnected', true], [$this->provider('todoist')['state'], $this->provider('todoist')['setup_ready']]);

        app(CredentialVault::class)->store('google', 'db-id', 'db-secret', null, $this->user);
        $this->assertSame(['disconnected', true], [$this->provider('google')['state'], $this->provider('google')['setup_ready']]);
    }

    public function test_account_states_connected_syncing_error_and_revoked(): void
    {
        config(['services.google_calendar' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x'], 'services.todoist' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x'], 'services.microsoft_calendar' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x']]);
        $ok = $this->account('google');
        $this->assertSame('connected', $this->provider('google')['state']);

        SyncRun::create(['user_id' => $this->user->id, 'calendar_account_id' => $ok->id, 'trigger' => 'manual', 'started_at' => now()->subMinute(), 'status' => 'running', 'mode' => 'incremental']);
        $this->assertSame(['syncing', 'running'], [$this->provider('google')['accounts'][0]['state']['state'], $this->provider('google')['accounts'][0]['state']['detail']]);
        $this->assertSame('syncing', $this->provider('google')['state']);

        SyncRun::query()->update(['started_at' => now()->subMinutes(30)]);
        $this->assertSame('connected', $this->provider('google')['state'], 'a run stuck for 30 minutes is not "syncing"');

        $this->account('todoist', ['status' => 'error', 'last_error' => 'The server returned an error (500).', 'retry_after' => now()->addMinutes(5)]);
        $todoist = $this->provider('todoist');
        $this->assertSame(['error', 'waiting'], [$todoist['state'], $todoist['accounts'][0]['state']['detail']]);

        $this->account('outlook', ['status' => 'revoked']);
        $this->assertSame(['error', 'revoked'], [$this->provider('outlook')['state'], $this->provider('outlook')['accounts'][0]['state']['detail']]);
    }

    public function test_one_bad_account_makes_the_provider_error_even_when_another_is_fine(): void
    {
        config(['services.google_calendar' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x']]);
        $this->account('google');
        $this->account('google', ['scopes_ok' => false]);
        $google = $this->provider('google');
        $this->assertSame(['error', 2, 'scope'], [$google['state'], count($google['accounts']), $google['accounts'][1]['state']['detail']]);
    }

    public function test_users_only_see_their_own_accounts_and_tokens_are_never_returned(): void
    {
        config(['services.google_calendar' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x']]);
        $other = User::factory()->create(['email' => 'other@example.com']);
        $this->account('google', ['email' => 'victim@example.com'], $other);
        $mine = $this->account('google', ['email' => 'mine@example.com']);
        $response = $this->actingAs($this->user)->getJson('/api/integrations/catalog')->assertOk();
        $google = collect($response->json('data.providers'))->firstWhere('id', 'google');
        $this->assertSame([$mine->id], array_column($google['accounts'], 'id'));
        $this->assertStringNotContainsString('victim@example.com', $response->getContent());
        $this->assertStringNotContainsString('SECRET-ACCESS', $response->getContent());
        $this->assertStringNotContainsString('SECRET-REFRESH', $response->getContent());
    }

    public function test_administrators_are_told_they_can_manage(): void
    {
        $this->user->forceFill(['is_admin' => true])->save();
        $this->actingAs($this->user)->getJson('/api/integrations/catalog')->assertOk()->assertJsonPath('data.can_manage', true);
    }
}
