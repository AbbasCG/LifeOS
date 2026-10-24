<?php

namespace Tests\Feature;

use App\Jobs\SyncCalendarAccount;
use App\Models\CalendarAccount;
use App\Models\ExternalEvent;
use App\Models\InboxNotification;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class CalendarIntegrationTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-01-04 07:00:00', 'UTC'));
        config([
            'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.microsoft_calendar' => ['client_id' => 'mid', 'client_secret' => 'msecret', 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/outlook/callback'],
        ]);
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5]]]);
        $this->actingAs($this->user);
    }

    /** @var list<array<string, mixed>>|null */
    private ?array $googleItems = null;

    private int $tokenStatus = 200;

    private int $calendarStatus = 200;

    private bool $faked = false;

    /**
     * Fake Google once; tests change the returned data through properties (Http::fake stubs cannot be replaced).
     *
     * @param  list<array<string, mixed>>|null  $items
     */
    private function fakeGoogle(?array $items = null, int $tokenStatus = 200, int $calendarStatus = 200): void
    {
        $this->googleItems = $items ?? [
            ['id' => 'evt1', 'summary' => 'Client call', 'start' => ['dateTime' => '2027-01-04T10:00:00+01:00'], 'end' => ['dateTime' => '2027-01-04T11:00:00+01:00']],
            ['id' => 'evt2', 'summary' => 'Offsite', 'start' => ['date' => '2027-01-06'], 'end' => ['date' => '2027-01-07']],
            ['id' => 'evt3', 'summary' => 'Optional', 'transparency' => 'transparent', 'start' => ['dateTime' => '2027-01-05T10:00:00Z'], 'end' => ['dateTime' => '2027-01-05T11:00:00Z']],
            ['id' => 'evt4', 'summary' => 'Cancelled', 'status' => 'cancelled', 'start' => ['dateTime' => '2027-01-05T12:00:00Z'], 'end' => ['dateTime' => '2027-01-05T13:00:00Z']],
        ];
        $this->tokenStatus = $tokenStatus;
        $this->calendarStatus = $calendarStatus;
        if ($this->faked) {
            return;
        }
        $this->faked = true;
        Http::fake([
            'oauth2.googleapis.com/token' => fn () => $this->tokenStatus === 200 ? Http::response(['access_token' => 'g-access', 'refresh_token' => 'g-refresh', 'expires_in' => 3600, 'scope' => 'calendar.readonly']) : Http::response(['error' => 'invalid_grant'], $this->tokenStatus),
            'openidconnect.googleapis.com/*' => Http::response(['sub' => 'google-user-1', 'email' => 'me@gmail.com', 'name' => 'Me']),
            'www.googleapis.com/calendar/v3/users/me/calendarList*' => fn () => $this->calendarStatus === 200 ? Http::response(['items' => [['id' => 'primary', 'timeZone' => 'Europe/Amsterdam']]]) : Http::response(['error' => ['code' => $this->calendarStatus]], $this->calendarStatus),
            'www.googleapis.com/calendar/v3/calendars/*' => fn () => Http::response(['items' => $this->googleItems]),
            'oauth2.googleapis.com/revoke' => Http::response([], 200),
        ]);
    }

    private function connectGoogle(): CalendarAccount
    {
        $url = $this->postJson('/api/integrations/google/connect')->assertOk()->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $query);
        $this->get('/api/integrations/google/callback?code=auth-code&state='.$query['state'])->assertRedirect('https://app.lifeos.test/settings/integrations?connected=google');

        return CalendarAccount::firstOrFail();
    }

    public function test_unconfigured_providers_cannot_connect_and_report_their_state(): void
    {
        config(['services.google_calendar.client_id' => null]);
        $this->getJson('/api/integrations')->assertOk()->assertJsonPath('providers.0.provider', 'google')->assertJsonPath('providers.0.configured', false)->assertJsonPath('providers.1.configured', true);
        $this->postJson('/api/integrations/google/connect')->assertUnprocessable()->assertJsonValidationErrors('provider');
        $this->postJson('/api/integrations/yahoo/connect')->assertNotFound();
    }

    public function test_authorization_url_uses_pkce_state_and_read_only_scope(): void
    {
        $url = $this->postJson('/api/integrations/google/connect')->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $q);

        $this->assertStringStartsWith('https://accounts.google.com/o/oauth2/v2/auth?', $url);
        $this->assertSame('S256', $q['code_challenge_method']);
        $this->assertSame(43, strlen($q['code_challenge']));
        $this->assertSame(40, strlen($q['state']));
        $this->assertStringContainsString('calendar.readonly', $q['scope']);
        $this->assertStringNotContainsString('auth/calendar ', $q['scope'].' ');
        $this->assertSame('offline', $q['access_type']);
    }

    public function test_callback_rejects_unknown_reused_or_foreign_state(): void
    {
        $this->fakeGoogle();
        $this->get('/api/integrations/google/callback?code=x&state=forged')->assertRedirect('https://app.lifeos.test/settings/integrations?error=state');
        $url = $this->postJson('/api/integrations/google/connect')->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $q);
        $this->get('/api/integrations/outlook/callback?code=x&state='.$q['state'])->assertRedirect('https://app.lifeos.test/settings/integrations?error=state');
        $this->get('/api/integrations/google/callback?code=x&state='.$q['state'])->assertRedirect('https://app.lifeos.test/settings/integrations?error=state');
        $url = $this->postJson('/api/integrations/google/connect')->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $q);
        $this->get('/api/integrations/google/callback?error=access_denied&state='.$q['state'])->assertRedirect('https://app.lifeos.test/settings/integrations?error=denied');
        $this->assertDatabaseCount('calendar_accounts', 0);
    }

    public function test_connecting_stores_encrypted_tokens_imports_busy_events_and_never_exposes_tokens(): void
    {
        $this->fakeGoogle();
        $account = $this->connectGoogle();

        Http::assertSent(fn (HttpRequest $r) => $r->url() === 'https://oauth2.googleapis.com/token' && $r['grant_type'] === 'authorization_code' && strlen($r['code_verifier']) === 96);
        $raw = DB::table('calendar_accounts')->first();
        $this->assertStringNotContainsString('g-access', $raw->access_token);
        $this->assertStringNotContainsString('g-refresh', $raw->refresh_token);
        $this->assertSame('g-access', $account->access_token);

        $this->assertSame(2, ExternalEvent::count());
        $this->assertSame('2027-01-04T09:00:00+00:00', ExternalEvent::where('title', 'Client call')->first()->starts_at->toIso8601String());
        $offsite = ExternalEvent::where('title', 'Offsite')->first();
        $this->assertTrue($offsite->all_day);
        $this->assertSame('2027-01-05T23:00:00+00:00', $offsite->starts_at->toIso8601String());

        $json = $this->getJson('/api/integrations')->assertOk()->assertJsonPath('providers.0.accounts.0.email', 'me@gmail.com')->assertJsonPath('providers.0.accounts.0.events_count', 2)->getContent();
        $this->assertStringNotContainsString('g-access', $json);
        $this->assertStringNotContainsString('g-refresh', $json);
        $this->assertDatabaseHas('audit_logs', ['user_id' => $this->user->id, 'action' => 'integration_connected']);
    }

    public function test_external_events_block_availability_and_planning_but_are_read_only(): void
    {
        $this->fakeGoogle();
        $this->connectGoogle();

        $this->getJson('/api/calendar?from=2027-01-04T00:00:00Z&to=2027-01-05T00:00:00Z')->assertJsonPath('data.0.source', 'google')->assertJsonPath('data.0.editable', false)->assertJsonPath('data.0.account_label', 'me@gmail.com');
        $this->getJson('/api/availability?date=2027-01-04')->assertJsonPath('days.0.slots.0.ends_at', '2027-01-04T09:00:00+00:00');
        $this->postJson('/api/events', ['title' => 'Clash', 'starts_at' => '2027-01-04T09:30:00Z', 'ends_at' => '2027-01-04T10:30:00Z'])->assertUnprocessable()->assertJsonFragment(['This time conflicts with “Client call” (2027-01-04T09:00:00+00:00 – 2027-01-04T10:00:00+00:00). Choose another time.']);
        Http::assertNotSent(fn (HttpRequest $r) => in_array($r->method(), ['POST', 'PATCH', 'PUT', 'DELETE'], true) && str_contains($r->url(), 'googleapis.com/calendar'));
    }

    public function test_resync_prevents_duplicates_and_removes_deleted_events(): void
    {
        $this->fakeGoogle();
        $account = $this->connectGoogle();
        app(CalendarSyncService::class)->sync($account->fresh());
        $this->assertSame(2, ExternalEvent::count());

        $this->fakeGoogle([['id' => 'evt1', 'summary' => 'Client call (moved)', 'start' => ['dateTime' => '2027-01-04T14:00:00Z'], 'end' => ['dateTime' => '2027-01-04T15:00:00Z']]]);
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertOk()->assertJsonPath('imported', 1)->assertJsonPath('account.events_count', 1);
        $this->assertSame('Client call (moved)', ExternalEvent::sole()->title);
    }

    public function test_expired_tokens_are_refreshed_and_revoked_access_is_handled(): void
    {
        $this->fakeGoogle();
        $account = $this->connectGoogle();
        $this->travel(2)->hours();
        app(CalendarSyncService::class)->sync($account->fresh());
        Http::assertSent(fn (HttpRequest $r) => $r->url() === 'https://oauth2.googleapis.com/token' && $r['grant_type'] === 'refresh_token' && $r['refresh_token'] === 'g-refresh');

        $this->travel(2)->hours();
        $this->fakeGoogle(null, 400);
        app(CalendarSyncService::class)->sync($account->fresh());
        $this->assertSame('revoked', $account->fresh()->status);
        $this->assertSame(1, InboxNotification::where('kind', 'integration')->count());
        $this->getJson('/api/calendar?from=2027-01-04T00:00:00Z&to=2027-01-08T00:00:00Z')->assertJsonCount(0, 'data');
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertUnprocessable();
        $this->assertDatabaseHas('audit_logs', ['action' => 'integration_revoked']);
    }

    public function test_transient_failures_keep_data_and_are_retried(): void
    {
        $this->fakeGoogle();
        $account = $this->connectGoogle();
        $this->fakeGoogle(null, 200, 503);

        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertStatus(502);
        $this->assertSame('error', $account->fresh()->status);
        $this->assertSame(2, ExternalEvent::count());

        Queue::fake();
        $this->artisan('lifeos:sync-calendars')->assertSuccessful();
        Queue::assertPushed(SyncCalendarAccount::class, fn ($job) => $job->accountId === $account->id);
    }

    public function test_outlook_import_handles_utc_times_all_day_and_paging(): void
    {
        Http::fake([
            'login.microsoftonline.com/*' => Http::response(['access_token' => 'm-access', 'refresh_token' => 'm-refresh', 'expires_in' => 3600]),
            'graph.microsoft.com/v1.0/me?*' => Http::response(['id' => 'ms-1', 'mail' => 'me@outlook.com', 'displayName' => 'Me']),
            // Only the default calendar is included for a new connection; "Birthdays" stays excluded until chosen.
            'graph.microsoft.com/v1.0/me/calendars?*' => Http::response(['value' => [['id' => 'cal-1', 'name' => 'Calendar', 'isDefaultCalendar' => true], ['id' => 'cal-2', 'name' => 'Birthdays', 'isDefaultCalendar' => false]]]),
            'graph.microsoft.com/v1.0/me/calendars/cal-2/*' => Http::response(['value' => [['id' => 'b1', 'subject' => 'Birthday', 'start' => ['dateTime' => '2027-01-05T00:00:00'], 'end' => ['dateTime' => '2027-01-05T01:00:00'], 'showAs' => 'busy']]]),
            'graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?*' => Http::response(['value' => [['id' => 'o1', 'subject' => 'Standup', 'start' => ['dateTime' => '2027-01-05T08:30:00.0000000'], 'end' => ['dateTime' => '2027-01-05T08:45:00.0000000'], 'showAs' => 'busy']], '@odata.nextLink' => 'https://graph.microsoft.com/v1.0/me/calendarView/page2']),
            'graph.microsoft.com/v1.0/me/calendarView/page2' => Http::response(['value' => [['id' => 'o2', 'subject' => 'Holiday', 'isAllDay' => true, 'start' => ['dateTime' => '2027-01-07T00:00:00.0000000'], 'end' => ['dateTime' => '2027-01-08T00:00:00.0000000'], 'showAs' => 'oof'], ['id' => 'o3', 'subject' => 'Free', 'showAs' => 'free', 'start' => ['dateTime' => '2027-01-05T10:00:00'], 'end' => ['dateTime' => '2027-01-05T11:00:00']]], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=abc']),
        ]);
        $url = $this->postJson('/api/integrations/outlook/connect')->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $q);
        $this->assertStringContainsString('Calendars.Read', $q['scope']);
        $this->assertStringNotContainsString('ReadWrite', $q['scope']);
        $this->get('/api/integrations/outlook/callback?code=c&state='.$q['state'])->assertRedirect('https://app.lifeos.test/settings/integrations?connected=outlook');

        $this->assertSame(2, ExternalEvent::count());
        $this->assertSame('2027-01-05T08:30:00+00:00', ExternalEvent::where('external_id', 'o1')->first()->starts_at->toIso8601String());
        $this->assertSame('2027-01-06T23:00:00+00:00', ExternalEvent::where('external_id', 'o2')->first()->starts_at->toIso8601String());
        Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'calendarView/delta') && str_contains($r->header('Prefer')[0] ?? '', 'outlook.timezone="UTC"'));
        Http::assertNotSent(fn (HttpRequest $r) => str_contains($r->url(), 'cal-2'));
        $this->assertSame([true, false], array_column(CalendarAccount::firstOrFail()->collections, 'included'));
    }

    public function test_accounts_are_private_and_disconnect_removes_imported_events(): void
    {
        $this->fakeGoogle();
        $account = $this->connectGoogle();
        $this->actingAs(User::factory()->create());
        $this->getJson('/api/integrations')->assertJsonCount(0, 'providers.0.accounts');
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertNotFound();
        $this->deleteJson("/api/integrations/accounts/{$account->id}")->assertNotFound();

        $this->actingAs($this->user)->deleteJson("/api/integrations/accounts/{$account->id}")->assertOk();
        $this->assertDatabaseCount('calendar_accounts', 0);
        $this->assertDatabaseCount('external_events', 0);
        Http::assertSent(fn (HttpRequest $r) => $r->url() === 'https://oauth2.googleapis.com/revoke');
        $this->assertDatabaseHas('audit_logs', ['action' => 'integration_disconnected']);
    }
}
