<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Permissions\ConnectionPermissions;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\ExternalTask;
use App\Models\SyncConflict;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The security review of the Connected Accounts routes, as tests: what one person's id does in another person's hands, what an administrator's role does and does not give,
 * and which sensitive changes are rate limited. Providers are faked and any request to one fails the test.
 */
class IntegrationsSecurityTest extends TestCase
{
    use RefreshDatabase;

    private User $victim;

    private CalendarAccount $account;

    private CalendarWriteLink $link;

    private SyncConflict $conflict;

    private ExternalTask $task;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-22 08:00:00', 'UTC'));
        config(['calendar_write.enabled' => true, 'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.todoist' => ['client_id' => 'tid', 'client_secret' => 'tsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/todoist/callback']]);
        $this->victim = User::factory()->create();
        $this->account = CalendarAccount::create(['user_id' => $this->victim->id, 'provider' => 'google', 'external_account_id' => 'v-1', 'email' => 'victim@example.test', 'access_token' => 'victim-token', 'refresh_token' => 'victim-refresh',
            'token_expires_at' => now()->addHour(), 'status' => 'active', 'collections' => [], 'write_granted_at' => now(), 'write_calendar_id' => 'work@group', 'write_calendar_name' => 'Work', 'permissions' => ['read', 'sync']]);
        $event = CalendarEvent::create(['user_id' => $this->victim->id, 'title' => 'Private meeting', 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 10:00:00']);
        $this->link = CalendarWriteLink::create(['user_id' => $this->victim->id, 'calendar_account_id' => $this->account->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'work@group',
            'external_id' => 'copy1', 'etag' => '"e"', 'title' => 'Old', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 10:00:00']);
        $this->conflict = SyncConflict::create(['user_id' => $this->victim->id, 'calendar_account_id' => $this->account->id, 'calendar_write_link_id' => $this->link->id, 'calendar_event_id' => $event->id,
            'local_title' => 'Private meeting', 'local_starts_at' => '2027-03-23 09:00:00', 'local_ends_at' => '2027-03-23 10:00:00']);
        $todoist = CalendarAccount::create(['user_id' => $this->victim->id, 'provider' => 'todoist', 'external_account_id' => 'v-t', 'access_token' => 'x', 'status' => 'active', 'collections' => [], 'permissions' => ['read', 'sync', 'import']]);
        $this->task = ExternalTask::create(['user_id' => $this->victim->id, 'calendar_account_id' => $todoist->id, 'external_id' => 't1', 'collection_id' => 'inbox', 'title' => 'Secret errand', 'status' => 'open']);
    }

    private function as(User $user): void
    {
        $this->actingAs($user)->withSession(['auth.password_confirmed_at' => now()->getTimestamp()]);
    }

    /** @return list<array{string, string, array<string, mixed>}> */
    private function attacks(): array
    {
        $a = $this->account->id;

        return [
            ['GET', "/api/integrations/accounts/{$a}/permissions", []],
            ['PUT', "/api/integrations/accounts/{$a}/permissions", ['preset' => 'full', 'confirm_delete' => true]],
            ['PUT', "/api/integrations/accounts/{$a}/sync-settings", ['direction' => 'two_way', 'conflict_policy' => 'prefer_lifeos']],
            ['POST', "/api/integrations/accounts/{$a}/sync/preview", []],
            ['POST', "/api/integrations/accounts/{$a}/sync/push", []],
            ['GET', "/api/integrations/accounts/{$a}/sync-conflicts", []],
            ['POST', "/api/integrations/sync-conflicts/{$this->conflict->id}/resolve", ['resolution' => 'keep_lifeos', 'confirm_overwrite' => true]],
            ['PATCH', "/api/integrations/accounts/{$a}", ['included' => []]],
            ['POST', "/api/integrations/accounts/{$a}/sync", []],
            ['GET', "/api/integrations/accounts/{$a}/write/calendars", []],
            ['PUT', "/api/integrations/accounts/{$a}/write", ['calendar_id' => 'attacker@group']],
            ['POST', "/api/integrations/accounts/{$a}/write/connect", []],
            ['POST', '/api/calendar-write/preview', ['op' => 'delete', 'account_id' => $a, 'link_id' => $this->link->id]],
            ['POST', '/api/calendar-write/confirm', ['token' => 'forged']],
            ['POST', "/api/connected/tasks/{$this->task->id}/copy", []],
            ['DELETE', "/api/integrations/accounts/{$a}", []],
        ];
    }

    private function assertNothingChanged(): void
    {
        $this->assertSame(2, CalendarAccount::count(), 'no account was added or removed');
        $account = $this->account->fresh();
        $this->assertSame(['read', 'sync'], $account->permissions);
        $this->assertSame(['inbound', 'ask', null], [$account->sync_direction, $account->conflict_policy, $account->sync_paused_at]);
        $this->assertSame('work@group', $account->write_calendar_id);
        $this->assertSame(1, CalendarWriteLink::count());
        $this->assertSame('Old', $this->link->fresh()->title);
        $this->assertSame('open', $this->conflict->fresh()->status);
        $this->assertSame(0, Task::count(), 'nothing was copied into the attacker\'s tasks');
        $this->assertSame(0, AuditLog::whereIn('action', ['integration_permissions_changed', 'integration_sync_settings_changed', 'sync_conflict_resolved', 'integration_disconnected', 'calendar_write'])->count());
        Http::assertNothingSent();
    }

    public function test_another_persons_ids_open_nothing_and_change_nothing(): void
    {
        Http::fake();
        $this->as(User::factory()->create());
        foreach ($this->attacks() as [$method, $url, $body]) {
            Cache::flush();   // judge each route on its own, not on the rate limit left by the previous one
            $status = $this->json($method, $url, $body)->getStatusCode();
            $this->assertContains($status, [403, 404, 422], "{$method} {$url} answered {$status} to somebody else");
        }
        $this->assertNothingChanged();
    }

    public function test_being_an_administrator_gives_no_access_to_other_peoples_connections(): void
    {
        Http::fake();
        $admin = User::factory()->create();
        $admin->forceFill(['is_admin' => true])->save();
        $this->as($admin);
        foreach ($this->attacks() as [$method, $url, $body]) {
            Cache::flush();
            $status = $this->json($method, $url, $body)->getStatusCode();
            $this->assertContains($status, [403, 404, 422], "{$method} {$url} answered {$status} to an administrator");
        }
        $this->assertNothingChanged();
        // The administrator screens show configuration, never people's accounts or tokens.
        $body = (string) $this->getJson('/api/admin/integrations/credentials')->getContent().(string) $this->getJson('/api/admin/integrations/audit')->getContent();
        foreach (['victim@example.test', 'victim-token', 'victim-refresh'] as $leak) {
            $this->assertStringNotContainsString($leak, $body);
        }
    }

    public function test_the_owner_still_can_and_a_guest_never_can(): void
    {
        Http::fake();
        $this->as($this->victim);
        $this->getJson("/api/integrations/accounts/{$this->account->id}/permissions")->assertOk();
        $this->getJson("/api/integrations/accounts/{$this->account->id}/sync-conflicts")->assertOk()->assertJsonPath('data.0.title', 'Private meeting');
        $this->app['auth']->forgetGuards();
        $this->flushSession();
        foreach ($this->attacks() as [$method, $url, $body]) {
            $this->json($method, $url, $body)->assertUnauthorized();
        }
        Http::assertNothingSent();
    }

    public function test_changes_that_widen_what_leaves_lifeos_need_a_recent_password(): void
    {
        $this->actingAs($this->victim);   // signed in, but no recent password confirmation
        $a = $this->account->id;
        $this->putJson("/api/integrations/accounts/{$a}/permissions", ['preset' => 'read_create'])->assertStatus(423);
        $this->putJson("/api/integrations/accounts/{$a}/sync-settings", ['direction' => 'two_way'])->assertStatus(423);
        $this->postJson("/api/integrations/sync-conflicts/{$this->conflict->id}/resolve", ['resolution' => 'keep_external'])->assertStatus(423);
        $this->assertNothingChanged();
    }

    public function test_the_sensitive_changes_are_rate_limited(): void
    {
        Http::fake();
        $this->as($this->victim);
        $codes = [];
        foreach (range(1, 9) as $i) {
            $codes[] = $this->putJson("/api/integrations/accounts/{$this->account->id}/sync-settings", ['paused' => $i % 2 === 0])->getStatusCode();
        }
        $this->assertContains(429, $codes, 'repeated changes are slowed down');
        $this->assertSame(200, $codes[0]);
    }

    public function test_tokens_never_appear_in_any_answer_the_owner_gets(): void
    {
        Http::fake();
        $this->as($this->victim);
        $body = (string) $this->getJson('/api/integrations')->getContent().(string) $this->getJson('/api/integrations/catalog')->getContent()
            .(string) $this->getJson("/api/integrations/accounts/{$this->account->id}/permissions")->getContent().(string) $this->getJson("/api/integrations/accounts/{$this->account->id}/sync-conflicts")->getContent();
        foreach (['victim-token', 'victim-refresh', 'gsecret', 'tsecret'] as $leak) {
            $this->assertStringNotContainsString($leak, $body);
        }
    }

    public function test_every_route_that_changes_a_connection_goes_through_the_permission_check_before_it_reaches_a_provider(): void
    {
        // A static guard: any controller or service that calls a provider's write methods must also mention ConnectionPermissions, so a new writer cannot skip the check.
        $writers = ['createEvent(', 'updateEvent(', 'deleteEvent('];
        $offenders = [];
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(app_path())) as $file) {
            if (! $file->isFile() || $file->getExtension() !== 'php' || str_contains($file->getPathname(), '/Integrations/Calendar/')) {
                continue;
            }
            $code = (string) file_get_contents($file->getPathname());
            foreach ($writers as $call) {
                if (str_contains($code, '->'.$call) && ! str_contains($code, 'ConnectionPermissions')) {
                    $offenders[] = str_replace(base_path().'/', '', $file->getPathname()).' calls '.$call;
                }
            }
        }
        $this->assertSame([], $offenders);
        $this->assertTrue(method_exists(ConnectionPermissions::class, 'authorize'));
    }
}
