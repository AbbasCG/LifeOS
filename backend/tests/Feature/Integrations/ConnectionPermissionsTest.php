<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Permissions\ConnectionPermissions;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\ExternalTask;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * What LifeOS may do with ONE connected account: the choice is stored per connection, validated against what the service can do, shown honestly, and enforced on the server
 * before anything is sent to a provider or copied from it. Providers are faked; nothing here writes to a real account.
 */
class ConnectionPermissionsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private CalendarAccount $google;

    private CalendarEvent $event;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-22 08:00:00', 'UTC'));
        config([
            'calendar_write.enabled' => true, 'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.todoist' => ['client_id' => 'tid', 'client_secret' => 'tsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/todoist/callback'],
        ]);
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->google = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g-1', 'email' => 'me@gmail.com', 'access_token' => 'tok', 'refresh_token' => 'r',
            'token_expires_at' => now()->addHour(), 'scopes' => 'openid https://www.googleapis.com/auth/calendar.readonly', 'status' => 'active', 'collections' => []]);
        $this->event = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
        $this->actingAs($this->user)->withSession(['auth.password_confirmed_at' => now()->getTimestamp()]);
    }

    private function perms(): ConnectionPermissions
    {
        return app(ConnectionPermissions::class);
    }

    /** The account after the person gave the separate write permission at the provider and picked a calendar. */
    private function writable(CalendarAccount $account, ?array $permissions): CalendarAccount
    {
        $account->forceFill(['write_granted_at' => now(), 'write_calendar_id' => 'work@group', 'write_calendar_name' => 'Work', 'permissions' => $permissions])->save();

        return $account;
    }

    private function preview(string $op, array $extra = []): TestResponse
    {
        return $this->postJson('/api/calendar-write/preview', ['op' => $op, 'account_id' => $this->google->id] + $extra);
    }

    private function link(): CalendarWriteLink
    {
        return CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->google->id, 'calendar_event_id' => $this->event->id, 'calendar_id' => 'work@group',
            'external_id' => 'lifeos123', 'etag' => '"e1"', 'title' => 'Old title', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
    }

    private function sent(): array
    {
        return collect(Http::recorded())->map(fn ($pair) => $pair[0])->filter(fn (HttpRequest $r) => $r->method() !== 'GET')->values()->all();
    }

    // ---- what each service can do (from the code) ----

    public function test_the_matrix_says_honestly_what_each_service_can_do(): void
    {
        $matrix = fn (string $p) => $this->perms()->capabilities($p);
        $this->assertSame(['read', 'sync', 'export', 'create', 'update', 'delete'], $matrix('google'));
        $this->assertSame(['read', 'sync', 'export', 'create', 'update', 'delete'], $matrix('outlook'));
        $this->assertSame(['read', 'sync', 'import'], $matrix('google_tasks'));
        $this->assertSame(['read', 'sync', 'import'], $matrix('microsoft_todo'));
        $this->assertSame(['read', 'sync', 'import'], $matrix('todoist'));
        $this->assertSame(['read', 'sync'], $matrix('ics'));
        $this->assertSame([], $matrix('nope'));
        $this->assertSame(['read_only', 'read_create', 'read_create_update', 'full'], $this->perms()->presets('google'));
        $this->assertSame(['read_only'], $this->perms()->presets('todoist'), 'a task service offers no choice that sends changes');
        config(['calendar_write.enabled' => false]);
        $this->assertSame(['read', 'sync'], $this->perms()->capabilities('google'), 'when the server has adding events switched off, no write is on offer');
        $this->assertSame(['read_only'], $this->perms()->presets('google'));
    }

    public function test_the_hub_shows_the_choice_what_is_possible_now_and_what_the_service_can_do(): void
    {
        $google = collect($this->getJson('/api/integrations')->assertOk()->json('providers'))->firstWhere('provider', 'google');
        $this->assertSame(['read', 'sync', 'export', 'create', 'update', 'delete'], $google['capabilities']);
        $this->assertSame(['read_only', 'read_create', 'read_create_update', 'full'], $google['presets']);
        $p = $google['accounts'][0]['permissions'];
        $this->assertSame(['read', 'sync'], $p['granted']);
        $this->assertTrue($p['legacy']);
        $this->assertSame('read_only', $p['preset']);
        $todoist = collect($this->getJson('/api/integrations')->json('providers'))->firstWhere('provider', 'todoist');
        $this->assertSame(['read', 'sync', 'import'], $todoist['capabilities']);
    }

    // ---- accounts that existed before this (nothing is taken away, Delete is not given) ----

    public function test_an_account_that_never_chose_keeps_what_it_could_do_and_does_not_get_delete(): void
    {
        $this->assertSame(['read', 'sync'], $this->perms()->granted($this->google), 'a calendar has nothing to import');
        $this->writable($this->google, null);
        $this->assertSame(['read', 'sync', 'export', 'create', 'update'], $this->perms()->granted($this->google->fresh()));
        $this->assertFalse($this->perms()->allows($this->google->fresh(), 'delete'));
        $this->assertTrue($this->perms()->allows($this->google->fresh(), 'create'));
        $task = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'todoist', 'external_account_id' => 't-1', 'access_token' => 'x', 'status' => 'active', 'collections' => []]);
        $this->assertSame(['read', 'sync', 'import'], $this->perms()->granted($task));
    }

    // ---- choosing ----

    public function test_a_preset_is_saved_audited_and_a_repeat_changes_nothing(): void
    {
        $this->putJson("/api/integrations/accounts/{$this->google->id}/permissions", ['preset' => 'read_create'])->assertOk()
            ->assertJsonPath('data.preset', 'read_create')->assertJsonPath('data.changes.added', ['export', 'create'])->assertJsonPath('data.legacy', false);
        $this->assertSame(['read', 'sync', 'export', 'create'], $this->google->fresh()->permissions);
        $log = AuditLog::where('action', 'integration_permissions_changed')->sole();
        $this->assertSame(['provider' => 'google', 'account_id' => $this->google->id, 'added' => 'export,create', 'removed' => ''], $log->meta);
        $this->putJson("/api/integrations/accounts/{$this->google->id}/permissions", ['preset' => 'read_create'])->assertOk()->assertJsonPath('data.changes.added', []);
        $this->assertSame(1, AuditLog::where('action', 'integration_permissions_changed')->count(), 'a repeat that changes nothing is not logged');
        $this->putJson("/api/integrations/accounts/{$this->google->id}/permissions", ['preset' => 'read_only'])->assertOk()->assertJsonPath('data.changes.removed', ['export', 'create']);
    }

    public function test_turning_delete_on_needs_its_own_confirmation_and_the_server_insists(): void
    {
        $url = "/api/integrations/accounts/{$this->google->id}/permissions";
        $this->putJson($url, ['preset' => 'full'])->assertUnprocessable()->assertJsonPath('code', 'delete_confirmation_required');
        $this->putJson($url, ['permissions' => ['read', 'sync', 'export', 'delete']])->assertUnprocessable()->assertJsonPath('code', 'delete_confirmation_required');
        $this->putJson($url, ['preset' => 'full', 'confirm_delete' => false])->assertUnprocessable();
        $this->assertNull($this->google->fresh()->permissions, 'nothing was saved');
        $this->putJson($url, ['preset' => 'full', 'confirm_delete' => true])->assertOk()->assertJsonPath('data.preset', 'full');
        $this->assertContains('delete', $this->google->fresh()->permissions);
        // Keeping Delete, or turning it off, does not ask again.
        $this->putJson($url, ['preset' => 'full'])->assertOk();
        $this->putJson($url, ['preset' => 'read_create_update'])->assertOk()->assertJsonPath('data.changes.removed', ['delete']);
    }

    public function test_only_what_the_service_can_do_can_be_chosen(): void
    {
        $task = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'todoist', 'external_account_id' => 't-1', 'access_token' => 'x', 'status' => 'active', 'collections' => []]);
        $url = "/api/integrations/accounts/{$task->id}/permissions";
        $this->putJson($url, ['preset' => 'full', 'confirm_delete' => true])->assertUnprocessable()->assertJsonValidationErrors('preset');
        $this->putJson($url, ['permissions' => ['read', 'export', 'create']])->assertUnprocessable()->assertJsonValidationErrors('permissions');
        $this->putJson($url, ['permissions' => ['read', 'sync', 'import']])->assertOk();
        $ics = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'ics', 'external_account_id' => 'i-1', 'access_token' => 'https://example.test/a.ics', 'status' => 'active', 'collections' => []]);
        $this->putJson("/api/integrations/accounts/{$ics->id}/permissions", ['permissions' => ['read', 'sync', 'import']])->assertUnprocessable();
        $this->putJson("/api/integrations/accounts/{$ics->id}/permissions", ['permissions' => ['read']])->assertOk();
        $this->assertSame(['read', 'sync', 'import'], $task->fresh()->permissions);
    }

    public function test_a_choice_must_make_sense(): void
    {
        $url = "/api/integrations/accounts/{$this->google->id}/permissions";
        $this->putJson($url, [])->assertUnprocessable();
        $this->putJson($url, ['preset' => 'full', 'permissions' => ['read']])->assertUnprocessable();
        $this->putJson($url, ['preset' => 'everything'])->assertUnprocessable();
        $this->putJson($url, ['permissions' => ['read', 'fly']])->assertUnprocessable();
        $this->putJson($url, ['permissions' => ['sync']])->assertUnprocessable()->assertJsonValidationErrors('permissions');   // reading cannot be turned off
        $this->putJson($url, ['permissions' => ['read', 'create']])->assertUnprocessable();                                  // a write needs sending to be allowed
        $this->putJson($url, ['permissions' => ['read', 'export']])->assertUnprocessable();                                  // sending with nothing to send
        $this->putJson($url, ['permissions' => ['read', 'read']])->assertUnprocessable();                                    // not distinct
        $this->assertNull($this->google->fresh()->permissions);
        $this->putJson($url, ['permissions' => ['read', 'export', 'update']])->assertOk()->assertJsonPath('data.preset', null);
    }

    public function test_it_is_private_and_needs_sign_in_and_a_recent_password(): void
    {
        $other = User::factory()->create();
        $theirs = CalendarAccount::create(['user_id' => $other->id, 'provider' => 'google', 'external_account_id' => 'g-2', 'access_token' => 'x', 'status' => 'active', 'collections' => []]);
        $this->getJson("/api/integrations/accounts/{$theirs->id}/permissions")->assertNotFound();
        $this->putJson("/api/integrations/accounts/{$theirs->id}/permissions", ['preset' => 'full', 'confirm_delete' => true])->assertNotFound();
        $this->assertNull($theirs->fresh()->permissions);

        $this->flushSession();
        $this->putJson("/api/integrations/accounts/{$this->google->id}/permissions", ['preset' => 'read_create'])->assertStatus(423);
        $this->assertNull($this->google->fresh()->permissions);

        $this->app['auth']->forgetGuards();
        $this->asGuestOnly();
    }

    private function asGuestOnly(): void
    {
        $this->flushSession();
        $this->getJson("/api/integrations/accounts/{$this->google->id}/permissions")->assertUnauthorized();
        $this->putJson("/api/integrations/accounts/{$this->google->id}/permissions", ['preset' => 'read_only'])->assertUnauthorized();
    }

    // ---- enforcement on the server ----

    public function test_nothing_is_sent_to_the_provider_when_the_person_has_not_allowed_it_even_if_the_provider_would(): void
    {
        Http::fake();
        $this->writable($this->google, ['read', 'sync']);
        $this->link();
        $deny = fn ($response) => $response->assertForbidden()->assertJsonPath('code', 'permission_denied')->assertJsonPath('reason', 'not_allowed');
        $deny($this->preview('create', ['event_id' => $this->event->id]))->assertJsonPath('operation', 'create');
        $deny($this->preview('update', ['event_id' => $this->event->id]))->assertJsonPath('operation', 'update');
        $deny($this->preview('delete', ['link_id' => CalendarWriteLink::sole()->id]))->assertJsonPath('operation', 'delete');
        Http::assertNothingSent();
        $this->assertSame(3, AuditLog::where('action', 'integration_permission_denied')->count(), 'each refusal is on record, with the operation and the reason and nothing else');
        $this->assertSame(['provider' => 'google', 'account_id' => $this->google->id, 'operation' => 'delete', 'reason' => 'not_allowed'], AuditLog::where('action', 'integration_permission_denied')->latest('id')->first()->meta);
    }

    public function test_create_allowed_update_and_delete_denied(): void
    {
        Http::fake(['www.googleapis.com/calendar/v3/calendars/*' => Http::response(['id' => 'lifeos123', 'etag' => '"e1"'])]);
        $this->writable($this->google, $this->perms()->presetOps('google', 'read_create'));
        $preview = $this->preview('create', ['event_id' => $this->event->id])->assertOk()->json();
        $this->postJson('/api/calendar-write/confirm', ['token' => $preview['token']])->assertOk();
        $this->assertCount(1, $this->sent());

        $this->event->update(['title' => 'Renamed']);
        $this->preview('update', ['event_id' => $this->event->id])->assertForbidden()->assertJsonPath('reason', 'not_allowed');
        $this->preview('delete', ['link_id' => CalendarWriteLink::sole()->id])->assertForbidden();
        $this->assertCount(1, $this->sent(), 'still only the one create');
    }

    public function test_a_choice_made_between_preview_and_confirm_is_respected(): void
    {
        Http::fake(['www.googleapis.com/calendar/v3/calendars/*' => Http::response(['id' => 'lifeos123', 'etag' => '"e1"'])]);
        $this->writable($this->google, $this->perms()->presetOps('google', 'read_create'));
        $preview = $this->preview('create', ['event_id' => $this->event->id])->assertOk()->json();
        $this->putJson("/api/integrations/accounts/{$this->google->id}/permissions", ['preset' => 'read_only'])->assertOk();
        $this->postJson('/api/calendar-write/confirm', ['token' => $preview['token']])->assertForbidden()->assertJsonPath('code', 'permission_denied');
        $this->assertSame([], $this->sent());
        $this->assertSame(0, CalendarWriteLink::count());
    }

    public function test_delete_works_only_after_the_person_turned_it_on(): void
    {
        Http::fake(['www.googleapis.com/calendar/v3/calendars/*' => Http::response([], 204)]);
        $this->writable($this->google, $this->perms()->presetOps('google', 'full'));
        $link = $this->link();
        $preview = $this->preview('delete', ['link_id' => $link->id])->assertOk()->json();
        $this->postJson('/api/calendar-write/confirm', ['token' => $preview['token']])->assertOk();
        $this->assertSame('DELETE', $this->sent()[0]->method());
        $this->assertSame(0, CalendarWriteLink::count());
    }

    public function test_the_providers_access_is_a_separate_requirement_and_asks_for_consent_again(): void
    {
        Http::fake();
        $this->google->forceFill(['permissions' => $this->perms()->presetOps('google', 'read_create')])->save();   // allowed in LifeOS, but the provider never gave write access
        $this->preview('create', ['event_id' => $this->event->id])->assertForbidden()->assertJsonPath('reason', 'reconsent_required');
        $summary = $this->perms()->summary($this->google->fresh());
        $this->assertSame(['read', 'sync', 'export', 'create'], $summary['granted']);
        $this->assertSame(['read', 'sync'], $summary['effective']);
        $this->assertSame(['export' => 'reconsent_required', 'create' => 'reconsent_required'], (array) $summary['blocked']);
        Http::assertNothingSent();
    }

    public function test_a_revoked_account_cannot_write(): void
    {
        Http::fake();
        $this->writable($this->google, $this->perms()->presetOps('google', 'full'));
        $this->google->forceFill(['status' => 'revoked'])->save();
        $this->preview('create', ['event_id' => $this->event->id])->assertForbidden()->assertJsonPath('reason', 'revoked');
        Http::assertNothingSent();
    }

    public function test_one_persons_choice_never_lets_another_person_write_to_their_account(): void
    {
        Http::fake();
        $this->writable($this->google, $this->perms()->presetOps('google', 'full'));
        $this->actingAs(User::factory()->create());
        $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $this->google->id, 'event_id' => $this->event->id])->assertUnprocessable();
        Http::assertNothingSent();
    }

    public function test_switching_sync_off_stops_background_syncing_only(): void
    {
        $this->google->forceFill(['permissions' => ['read']])->save();
        $sync = app(CalendarSyncService::class);
        $this->assertFalse($sync->due($this->google->fresh()), 'the scheduler skips it');
        Http::fake();
        $this->assertSame(0, $sync->sync($this->google->fresh(), 'scheduled'), 'a run queued before the change does nothing');
        Http::assertNothingSent();
        $this->google->forceFill(['permissions' => ['read', 'sync']])->save();
        $this->assertTrue($sync->due($this->google->fresh()));
    }

    public function test_importing_into_lifeos_needs_import_to_be_allowed(): void
    {
        $task = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'todoist', 'external_account_id' => 't-1', 'access_token' => 'x', 'status' => 'active', 'collections' => [], 'permissions' => ['read', 'sync']]);
        $external = ExternalTask::create(['user_id' => $this->user->id, 'calendar_account_id' => $task->id, 'external_id' => 'e1', 'collection_id' => 'inbox', 'title' => 'Call bank', 'status' => 'open']);
        $this->postJson("/api/connected/tasks/{$external->id}/copy")->assertForbidden()->assertJsonPath('reason', 'not_allowed');
        $this->assertSame(0, Task::count());
        $task->forceFill(['permissions' => ['read', 'sync', 'import']])->save();
        $this->postJson("/api/connected/tasks/{$external->id}/copy")->assertCreated();
    }

    public function test_no_token_or_secret_is_ever_part_of_what_is_shown(): void
    {
        $body = (string) $this->getJson('/api/integrations')->getContent().(string) $this->getJson("/api/integrations/accounts/{$this->google->id}/permissions")->getContent();
        foreach (['tok', 'gsecret', '"r"'] as $leak) {
            $this->assertStringNotContainsString($leak, $body);
        }
    }
}
