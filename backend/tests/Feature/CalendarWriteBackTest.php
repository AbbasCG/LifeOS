<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\ExternalEvent;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class CalendarWriteBackTest extends TestCase
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
            'calendar_write.enabled' => true,
            'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.microsoft_calendar' => ['client_id' => 'mid', 'client_secret' => 'msecret', 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/outlook/callback'],
        ]);
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->google = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g-1', 'email' => 'me@gmail.com', 'access_token' => 'read-token', 'refresh_token' => 'r',
            'token_expires_at' => now()->addHour(), 'scopes' => 'openid https://www.googleapis.com/auth/calendar.readonly', 'status' => 'active', 'collections' => []]);
        $this->event = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
        $this->actingAs($this->user);
    }

    /** The account as it is after the user granted the write permission and picked a calendar. */
    private function enable(CalendarAccount $account, string $calendar = 'work@group'): CalendarAccount
    {
        $account->forceFill(['write_granted_at' => now(), 'write_calendar_id' => $calendar, 'write_calendar_name' => 'Work'])->save();

        return $account;
    }

    private function writes(): Collection
    {
        return collect(Http::recorded())->map(fn ($pair) => $pair[0])->filter(fn (HttpRequest $r) => $r->method() !== 'GET')->values();
    }

    private function confirm(array $preview): TestResponse
    {
        return $this->postJson('/api/calendar-write/confirm', ['token' => $preview['token']]);
    }

    public function test_write_back_is_off_unless_the_server_enables_it(): void
    {
        config(['calendar_write.enabled' => false]);
        Http::fake();
        $hub = $this->getJson('/api/integrations')->assertOk();
        $this->assertFalse(collect($hub->json('providers'))->firstWhere('provider', 'google')['supports_write']);
        $this->assertFalse($hub->json('providers.0.accounts.0.write.available'));
        $this->postJson("/api/integrations/accounts/{$this->google->id}/write/connect")->assertUnprocessable();
        $this->enable($this->google);
        $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $this->google->id, 'event_id' => $this->event->id])->assertUnprocessable();
        $this->assertFalse($this->getJson('/api/calendar-write')->json('enabled'));
        Http::assertNothingSent();
    }

    public function test_write_permission_is_a_separate_consent_for_the_same_account(): void
    {
        $read = $this->postJson('/api/integrations/google/connect')->json('authorization_url');
        $this->assertStringNotContainsString('calendar.events', urldecode($read), 'connecting asks for read access only');

        $scope = 'openid https://www.googleapis.com/auth/calendar.readonly';
        $sub = 'g-1';
        Http::fake([
            'oauth2.googleapis.com/token' => function () use (&$scope) {
                return Http::response(['access_token' => 'write-token', 'refresh_token' => 'r2', 'expires_in' => 3600, 'scope' => $scope]);
            },
            'openidconnect.googleapis.com/*' => function () use (&$sub) {
                return Http::response(['sub' => $sub, 'email' => 'me@gmail.com']);
            },
            'www.googleapis.com/calendar/v3/users/me/calendarList*' => Http::response(['items' => [['id' => 'primary@gmail.com', 'summary' => 'Me', 'primary' => true], ['id' => 'work@group', 'summary' => 'Work']]]),
        ]);
        $consent = function () {
            $url = $this->postJson("/api/integrations/accounts/{$this->google->id}/write/connect")->assertOk()->json('authorization_url');
            parse_str(parse_url($url, PHP_URL_QUERY), $query);
            $this->assertSame(['me@gmail.com', 'true'], [$query['login_hint'], $query['include_granted_scopes']]);
            $this->assertStringContainsString('https://www.googleapis.com/auth/calendar.events', $query['scope']);

            return $this->get('/api/integrations/google/callback?code=c&state='.$query['state']);
        };

        $consent()->assertRedirect('https://app.lifeos.test/settings/integrations?error=write_scope&provider=google');
        $scope .= ' https://www.googleapis.com/auth/calendar.events.readonly';
        $consent()->assertRedirect('https://app.lifeos.test/settings/integrations?error=write_scope&provider=google');
        $scope .= ' https://www.googleapis.com/auth/calendar.events';
        $sub = 'someone-else';
        $consent()->assertRedirect('https://app.lifeos.test/settings/integrations?error=write_account&provider=google');
        $this->assertNull($this->google->fresh()->write_granted_at);
        $this->assertSame('read-token', $this->google->fresh()->access_token);

        $sub = 'g-1';
        $consent()->assertRedirect("https://app.lifeos.test/settings/integrations?write_granted={$this->google->id}");
        $account = $this->google->fresh();
        $this->assertSame('write-token', $account->access_token);
        $this->assertNotNull($account->write_granted_at);
        $this->assertSame(['available' => true, 'granted' => true, 'enabled' => false, 'calendar_id' => null, 'calendar_name' => null, 'copies' => 0],
            $this->getJson('/api/integrations')->json('providers.0.accounts.0.write'), 'nothing can be written until a calendar is picked');
        $this->assertSame(1, AuditLog::where('action', 'calendar_write_granted')->count());

        $this->getJson("/api/integrations/accounts/{$account->id}/write/calendars")->assertOk()->assertJsonPath('data.1.name', 'Work');
        Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'minAccessRole=writer'));
        $this->putJson("/api/integrations/accounts/{$account->id}/write", ['calendar_id' => 'someone-elses@group'])->assertUnprocessable();
        $this->putJson("/api/integrations/accounts/{$account->id}/write", ['calendar_id' => 'work@group'])->assertOk()->assertJsonPath('write.enabled', true)->assertJsonPath('write.calendar_name', 'Work');
        $this->putJson("/api/integrations/accounts/{$account->id}/write", ['calendar_id' => null])->assertOk()->assertJsonPath('write.enabled', false);
        $this->assertSame(0, $this->writes()->filter(fn ($r) => str_contains($r->url(), 'calendar/v3'))->count(), 'no calendar was changed');
    }

    public function test_adding_an_event_needs_a_preview_and_a_single_confirmation_and_is_audited(): void
    {
        $this->enable($this->google);
        Http::fake(['www.googleapis.com/calendar/v3/calendars/*' => Http::response(['id' => 'lifeos123', 'etag' => '"e1"'])]);

        $preview = $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $this->google->id, 'event_id' => $this->event->id])->assertOk()
            ->assertJsonPath('calendar.name', 'Work')->assertJsonPath('after.title', 'Deep work')->assertJsonPath('before', null)->json();
        Http::assertNothingSent();

        $this->confirm($preview)->assertOk()->assertJsonPath('op', 'create')->assertJsonPath('link.in_sync', true);
        $sent = $this->writes()->sole();
        $this->assertSame('https://www.googleapis.com/calendar/v3/calendars/work%40group/events', $sent->url());
        $this->assertMatchesRegularExpression('/^lifeos[0-9a-f]{24}$/', $sent['id'], 'client-chosen id: a retry cannot create a second copy');
        $this->assertSame(['Deep work', '2027-03-23T09:00:00Z', '2027-03-23T11:00:00Z', 'lifeos'], [$sent['summary'], $sent['start']['dateTime'], $sent['end']['dateTime'], $sent['extendedProperties']['private']['createdBy']]);
        $this->assertSame(['create', 'google', $this->event->id], array_values(array_intersect_key(AuditLog::where('action', 'calendar_write')->sole()->meta, array_flip(['op', 'provider', 'event_id']))));

        $this->confirm($preview)->assertUnprocessable()->assertJsonPath('errors.token.0', 'This preview has expired or was already used. Preview the change again.');
        $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $this->google->id, 'event_id' => $this->event->id])->assertUnprocessable();
        $this->postJson('/api/calendar-write/confirm', ['token' => 'forged'])->assertUnprocessable();
        $this->assertCount(1, $this->writes());

        // The copy comes back through sync but is shown once, as the LifeOS event.
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->google->id, 'calendar_id' => 'work@group', 'external_id' => 'lifeos123', 'title' => 'Deep work (Google)', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
        $titles = collect($this->getJson('/api/calendar?from=2027-03-23T00:00:00Z&to=2027-03-24T00:00:00Z')->json('data'))->pluck('title')->all();
        $this->assertSame(['Deep work'], $titles);
    }

    public function test_updates_and_removals_touch_only_copies_lifeos_made_and_respect_edits_made_there(): void
    {
        $this->enable($this->google);
        $link = CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->google->id, 'calendar_event_id' => $this->event->id, 'calendar_id' => 'work@group', 'external_id' => 'lifeos123', 'etag' => '"e1"', 'title' => 'Deep work', 'starts_at' => $this->event->starts_at, 'ends_at' => $this->event->ends_at]);
        $other = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Never added', 'starts_at' => '2027-03-24 09:00:00', 'ends_at' => '2027-03-24 10:00:00']);
        $patch = 0;
        Http::fake(['www.googleapis.com/calendar/v3/calendars/work%40group/events/lifeos123' => function (HttpRequest $r) use (&$patch) {
            if ($r->method() === 'PATCH') {
                return ++$patch === 1 ? Http::response(['error' => ['code' => 412]], 412) : Http::response(['id' => 'lifeos123', 'etag' => '"e3"']);
            }

            return Http::response(null, 204);
        }]);
        $preview = fn (array $q) => $this->postJson('/api/calendar-write/preview', $q + ['account_id' => $this->google->id]);

        $preview(['op' => 'update', 'event_id' => $this->event->id])->assertUnprocessable()->assertJsonPath('errors.event_id.0', 'The copy already matches this event.');
        $preview(['op' => 'update', 'event_id' => $other->id])->assertUnprocessable();
        $foreign = CalendarWriteLink::create(['user_id' => User::factory()->create()->id, 'calendar_account_id' => $this->google->id, 'calendar_id' => 'x', 'external_id' => 'theirs', 'title' => 'x', 'starts_at' => now(), 'ends_at' => now()]);
        $preview(['op' => 'delete', 'link_id' => $foreign->id])->assertUnprocessable();

        $this->event->update(['starts_at' => '2027-03-23 13:00:00', 'ends_at' => '2027-03-23 15:00:00']);
        $this->assertFalse($this->getJson('/api/calendar-write')->json('links.0.in_sync'));
        $update = $preview(['op' => 'update', 'event_id' => $this->event->id])->assertOk()->assertJsonPath('before.starts_at', '2027-03-23T09:00:00+00:00')->assertJsonPath('after.starts_at', '2027-03-23T13:00:00+00:00')->json();
        // Edited in Google since LifeOS added it: refused, nothing overwritten, failure audited.
        $this->confirm($update)->assertUnprocessable()->assertJsonPath('errors.calendar.0', fn ($m) => str_contains($m, 'changed in Google Calendar after LifeOS added it'));
        $this->assertSame('"e1"', $link->fresh()->etag);
        $this->assertSame('changed', AuditLog::where('action', 'calendar_write_failed')->sole()->meta['reason']);
        $this->assertSame(['"e1"'], $this->writes()->first()->header('If-Match'));

        $this->confirm($preview(['op' => 'update', 'event_id' => $this->event->id])->json())->assertOk()->assertJsonPath('link.in_sync', true);
        $this->assertSame('"e3"', $link->fresh()->etag);

        // Removing works even after the LifeOS event is gone.
        $this->event->delete();
        $this->assertTrue($this->getJson('/api/calendar-write')->json('links.0.orphan'));
        $this->confirm($preview(['op' => 'delete', 'link_id' => $link->id])->json())->assertOk()->assertJsonPath('link', null);
        $this->assertSame('DELETE', $this->writes()->last()->method());
        $this->assertSame(['"e3"'], $this->writes()->last()->header('If-Match'));
        $this->assertSame(1, CalendarWriteLink::count(), 'only the other user\'s link remains');
    }

    public function test_anything_changing_between_preview_and_confirm_is_refused_and_lost_answers_are_reported(): void
    {
        $this->enable($this->google);
        $round = 0;
        Http::fake(['www.googleapis.com/calendar/v3/calendars/*' => function (HttpRequest $r) use (&$round) {
            $round++;
            if ($round === 1) {
                throw new ConnectionException('timeout');
            }
            if ($r->method() === 'POST') {
                return Http::response(['error' => ['code' => 409, 'message' => 'The requested identifier already exists.']], 409);
            }

            return Http::response(['id' => 'lifeosabc', 'etag' => '"e9"']);
        }]);
        $preview = fn () => $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $this->google->id, 'event_id' => $this->event->id])->json();

        $stale = $preview();
        $this->event->update(['title' => 'Deep work (renamed)']);
        $this->confirm($stale)->assertStatus(409);
        Http::assertNothingSent();

        $this->confirm($preview())->assertUnprocessable()->assertJsonPath('errors.calendar.0', fn ($m) => str_contains($m, 'may or may not have been made'));
        $this->assertSame(0, CalendarWriteLink::count());

        // A retry after a lost answer finds the copy the first attempt made instead of adding a second one.
        $this->confirm($preview())->assertOk();
        $this->assertSame('lifeosabc', CalendarWriteLink::sole()->external_id);

        $this->google->forceFill(['write_calendar_id' => null])->save();
        $this->postJson('/api/calendar-write/preview', ['op' => 'delete', 'account_id' => $this->google->id, 'link_id' => CalendarWriteLink::sole()->id])->assertUnprocessable();
        $series = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Stand-up', 'timezone' => 'Europe/Amsterdam', 'recurrence' => ['freq' => 'daily'], 'starts_at' => '2027-03-23 08:00:00', 'ends_at' => '2027-03-23 08:15:00']);
        $this->enable($this->google);
        $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $this->google->id, 'event_id' => $series->id])->assertUnprocessable()->assertJsonPath('errors.event_id.0', 'Repeating events cannot be added yet — only single events.');
    }

    public function test_outlook_writes_in_utc_with_a_transaction_id_and_only_to_editable_calendars(): void
    {
        $outlook = $this->enable(CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'outlook', 'external_account_id' => 'o-1', 'email' => 'me@work.com', 'access_token' => 'a', 'refresh_token' => 'r', 'token_expires_at' => now()->addHour(), 'status' => 'active', 'collections' => []]), 'cal-1');
        Http::fake([
            'graph.microsoft.com/v1.0/me/calendars?*' => Http::response(['value' => [['id' => 'cal-1', 'name' => 'Calendar', 'canEdit' => true, 'isDefaultCalendar' => true], ['id' => 'shared', 'name' => 'Boss', 'canEdit' => false]]]),
            'graph.microsoft.com/v1.0/me/calendars/cal-1/events' => Http::response(['id' => 'AAMk1', '@odata.etag' => 'W/"1"'], 201),
        ]);
        $this->assertSame(['cal-1'], collect($this->getJson("/api/integrations/accounts/{$outlook->id}/write/calendars")->assertOk()->json('data'))->pluck('id')->all());

        $preview = $this->postJson('/api/calendar-write/preview', ['op' => 'create', 'account_id' => $outlook->id, 'event_id' => $this->event->id])->json();
        $this->confirm($preview)->assertOk();
        $sent = $this->writes()->sole();
        $this->assertSame(['Deep work', '2027-03-23T09:00:00', 'UTC'], [$sent['subject'], $sent['start']['dateTime'], $sent['start']['timeZone']]);
        $this->assertStringStartsWith('lifeos', $sent['transactionId']);
        $this->assertSame('W/"1"', CalendarWriteLink::sole()->etag);
        $this->assertArrayNotHasKey('etag', $this->getJson('/api/calendar-write')->json('links.0'));
    }

    public function test_sync_and_automations_never_write(): void
    {
        $this->enable($this->google);
        $this->google->update(['collections' => [['id' => 'work@group', 'name' => 'Work', 'color' => null, 'primary' => true, 'included' => true]]]);
        Http::fake(['www.googleapis.com/*' => Http::response(['items' => [], 'nextSyncToken' => 't'])]);
        Artisan::call('lifeos:sync-calendars');
        Artisan::call('lifeos:automations');
        $this->assertNotEmpty(Http::recorded(), 'sync ran');
        $this->assertCount(0, $this->writes(), 'only reads; writing always needs a confirmed preview');
    }
}
