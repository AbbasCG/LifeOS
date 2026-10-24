<?php

namespace Tests\Feature;

use App\Console\Commands\SyncCalendars;
use App\Jobs\SyncCalendarAccount;
use App\Models\CalendarAccount;
use App\Models\ExternalEvent;
use App\Models\ExternalTask;
use App\Models\SyncRun;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarService;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use GuzzleHttp\Promise\PromiseInterface;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class SyncReliabilityTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Monday 22 March 2027, 08:00 UTC — the week Europe switches to summer time (Sunday 28 March).
        $this->travelTo(CarbonImmutable::parse('2027-03-22 08:00:00', 'UTC'));
        config([
            'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.google_tasks' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google_tasks/callback'],
            'services.microsoft_calendar' => ['client_id' => 'mid', 'client_secret' => 'msecret', 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/outlook/callback'],
            'services.microsoft_todo' => ['client_id' => 'mid', 'client_secret' => 'msecret', 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/microsoft_todo/callback'],
        ]);
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->actingAs($this->user);
    }

    private function account(string $provider, array $collections, array $extra = []): CalendarAccount
    {
        return CalendarAccount::create([
            'user_id' => $this->user->id, 'provider' => $provider, 'external_account_id' => $provider.'-1', 'email' => 'me@example.com',
            'access_token' => 'access', 'refresh_token' => 'refresh', 'token_expires_at' => now()->addHour(), 'status' => 'active',
            'collections' => array_map(fn ($id) => ['id' => $id, 'name' => ucfirst($id), 'color' => null, 'primary' => $id === $collections[0], 'included' => true], $collections),
        ] + $extra);
    }

    private function event(string $id, string $title, string $start, string $end, array $extra = []): array
    {
        return ['id' => $id, 'summary' => $title, 'start' => ['dateTime' => $start], 'end' => ['dateTime' => $end], 'iCalUID' => "{$id}@google.com"] + $extra;
    }

    /**
     * @param  callable(HttpRequest): PromiseInterface  $events
     */
    private function fakeGoogle(callable $events, array $calendars = ['primary']): void
    {
        Http::fake([
            'www.googleapis.com/calendar/v3/users/me/calendarList*' => Http::response(['items' => array_map(fn ($id) => ['id' => $id, 'summary' => ucfirst($id), 'primary' => $id === 'primary', 'timeZone' => 'Europe/Amsterdam'], $calendars)]),
            'www.googleapis.com/calendar/v3/calendars/*' => $events,
            'oauth2.googleapis.com/*' => Http::response(['access_token' => 'new', 'expires_in' => 3600]),
        ]);
    }

    public function test_google_incremental_sync_applies_moves_and_cancellations_and_recovers_from_expired_tokens(): void
    {
        $calls = [];
        $round = 0;
        $this->fakeGoogle(function (HttpRequest $r) use (&$calls, &$round) {
            $calls[] = $r->data();

            return match (true) {
                $round === 0 => Http::response(['items' => [
                    $this->event('standup', 'Stand-up', '2027-03-23T09:00:00+01:00', '2027-03-23T09:15:00+01:00'),
                    $this->event('review', 'Design review', '2027-03-24T14:00:00+01:00', '2027-03-24T15:00:00+01:00'),
                ], 'nextSyncToken' => 'token-1']),
                $round === 1 => Http::response(['items' => [
                    // Moved one hour later, and the review was cancelled.
                    $this->event('standup', 'Stand-up', '2027-03-23T10:00:00+01:00', '2027-03-23T10:15:00+01:00'),
                    ['id' => 'review', 'status' => 'cancelled'],
                ], 'nextSyncToken' => 'token-2']),
                ($r->data()['syncToken'] ?? null) === 'token-2' => Http::response(['error' => ['code' => 410, 'message' => 'Sync token is no longer valid']], 410),
                default => Http::response(['items' => [$this->event('standup', 'Stand-up', '2027-03-23T10:00:00+01:00', '2027-03-23T10:15:00+01:00')], 'nextSyncToken' => 'token-3']),
            };
        });
        $account = $this->account('google', ['primary']);
        $sync = app(CalendarSyncService::class);

        $sync->sync($account);
        $this->assertSame(2, ExternalEvent::count());
        $this->assertArrayHasKey('timeMin', $calls[0]);
        $this->assertSame('standup@google.com', ExternalEvent::where('title', 'Stand-up')->value('ical_uid'));

        $round = 1;
        $sync->sync($account->fresh());
        $this->assertSame(['syncToken' => 'token-1'], array_intersect_key($calls[1], ['syncToken' => 1, 'timeMin' => 1]), 'incremental reads send only the token');
        $standup = ExternalEvent::sole();
        $this->assertSame('2027-03-23 08:00', $standup->previous_starts_at->format('Y-m-d H:i'));
        $this->assertSame('2027-03-23 09:00', $standup->starts_at->format('Y-m-d H:i'));
        $run = SyncRun::latest('id')->first();
        $this->assertSame(['incremental', 'success', 1, 1], [$run->mode, $run->status, $run->moved, $run->removed]);
        $this->assertSame('Design review', $run->details['cancelled'][0]['title']);

        // An expired token (410) falls back to a full read transparently.
        $round = 2;
        $sync->sync($account->fresh());
        $this->assertArrayHasKey('timeMin', end($calls));
        $this->assertSame('token-3', $account->fresh()->sync_state['primary']['token']);
        $this->assertSame('full', SyncRun::latest('id')->first()->mode);
    }

    public function test_a_full_read_is_forced_at_least_daily(): void
    {
        $calls = [];
        $this->fakeGoogle(function (HttpRequest $r) use (&$calls) {
            $calls[] = $r->data();

            return Http::response(['items' => [], 'nextSyncToken' => 'tok']);
        });
        $account = $this->account('google', ['primary'], ['sync_state' => ['primary' => ['token' => 'tok', 'full_at' => now()->subHours(25)->toIso8601String()]]]);
        app(CalendarSyncService::class)->sync($account);
        $this->assertArrayHasKey('timeMin', $calls[0]);
        $this->assertArrayNotHasKey('syncToken', $calls[0]);
    }

    public function test_google_rate_limits_are_not_mistaken_for_revoked_access_and_are_honoured(): void
    {
        $this->fakeGoogle(fn () => Http::response(['error' => ['code' => 403, 'errors' => [['reason' => 'rateLimitExceeded']]]], 403));
        $account = $this->account('google', ['primary']);

        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertStatus(429)->assertJsonPath('retry_after', 60);
        $account->refresh();
        $this->assertSame('error', $account->status, 'a rate limit is not a revoked account');
        $this->assertTrue($account->retry_after->isFuture());
        $this->assertSame('rate_limited', SyncRun::latest('id')->value('status'));
        $this->assertFalse(app(CalendarSyncService::class)->due($account));

        Queue::fake();
        $this->artisan(SyncCalendars::class)->assertSuccessful();
        Queue::assertNothingPushed();

        // While waiting, a manual sync does not hit the provider again.
        Http::assertSentCount(2);
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertStatus(429);
        Http::assertSentCount(2);
    }

    public function test_retry_after_headers_are_used_and_jobs_wait_that_long(): void
    {
        $this->fakeGoogle(fn () => Http::response(['error' => ['code' => 429]], 429, ['Retry-After' => '120']));
        $account = $this->account('google', ['primary']);
        $job = (new SyncCalendarAccount($account->id))->withFakeQueueInteractions();
        $job->handle(app(CalendarSyncService::class));
        $job->assertReleased(120);
        $this->assertEqualsWithDelta(120, now()->diffInSeconds($account->fresh()->retry_after), 2);
    }

    public function test_one_failing_calendar_does_not_discard_the_others(): void
    {
        $this->fakeGoogle(fn (HttpRequest $r) => str_contains($r->url(), 'calendars/broken/')
            ? Http::response(['error' => ['code' => 500]], 500)
            : Http::response(['items' => [$this->event('a', 'Planning', '2027-03-23T09:00:00Z', '2027-03-23T10:00:00Z')]]), ['primary', 'broken']);
        $account = $this->account('google', ['primary', 'broken']);

        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertOk();
        $account->refresh();
        $this->assertSame(['Planning'], ExternalEvent::pluck('title')->all());
        $this->assertSame('error', $account->status);
        $this->assertStringContainsString('Could not read Broken', $account->last_error);
        $this->assertNotNull($account->last_synced_at, 'partial success still refreshes what could be read');
        $this->assertSame('partial', SyncRun::latest('id')->value('status'));
    }

    public function test_concurrent_syncs_of_one_account_are_prevented(): void
    {
        $this->fakeGoogle(fn () => Http::response(['items' => []]));
        $account = $this->account('google', ['primary']);
        $lock = Cache::lock("connected-sync:{$account->id}", 300);
        $lock->get();

        $this->assertSame(0, app(CalendarSyncService::class)->sync($account));
        Http::assertNothingSent();
        $this->assertSame(0, SyncRun::count());
        $lock->release();
    }

    public function test_missing_read_permission_is_detected_at_connect_time(): void
    {
        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'a', 'refresh_token' => 'r', 'expires_in' => 3600, 'scope' => 'openid https://www.googleapis.com/auth/userinfo.email']),
            'openidconnect.googleapis.com/*' => Http::response(['sub' => 'g-1', 'email' => 'me@gmail.com']),
        ]);
        $url = $this->postJson('/api/integrations/google/connect')->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $q);
        $this->get('/api/integrations/google/callback?code=c&state='.$q['state'])->assertRedirect('https://app.lifeos.test/settings/integrations?error=scope&provider=google');
        $account = CalendarAccount::sole();
        $this->assertFalse($account->scopes_ok);
        $this->assertStringContainsString('did not grant the read permission', $account->last_error);
        Http::assertNotSent(fn (HttpRequest $r) => str_contains($r->url(), 'calendar/v3'));
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertUnprocessable();
        $this->assertSame([false], array_column($this->getJson('/api/integrations')->json('providers.0.accounts'), 'scopes_ok'));
    }

    public function test_the_same_meeting_is_shown_once_by_stable_identifier(): void
    {
        $google = $this->account('google', ['primary']);
        $outlook = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'outlook', 'external_account_id' => 'o', 'access_token' => 'x', 'status' => 'active']);
        $at = fn (string $t) => CarbonImmutable::parse("2027-03-23 {$t}", 'UTC');
        // Same invite, different titles in each calendar (Outlook adds a prefix): matched by iCalUID, not by title.
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'calendar_id' => 'primary', 'external_id' => 'g1', 'title' => 'Board meeting', 'ical_uid' => 'UID-1', 'starts_at' => $at('09:00'), 'ends_at' => $at('10:00')]);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $outlook->id, 'calendar_id' => 'c', 'external_id' => 'o1', 'title' => 'FW: Board meeting', 'ical_uid' => 'uid-1', 'starts_at' => $at('09:00'), 'ends_at' => $at('10:00')]);
        // A recurring occurrence moved in one calendar but not yet in the other: same UID + original start.
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'calendar_id' => 'primary', 'external_id' => 'g2', 'title' => 'Weekly 1:1', 'ical_uid' => 'UID-2', 'series_id' => 's', 'original_start' => $at('13:00'), 'starts_at' => $at('14:00'), 'ends_at' => $at('14:30')]);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $outlook->id, 'calendar_id' => 'c', 'external_id' => 'o2', 'title' => 'Weekly 1:1', 'ical_uid' => 'UID-2', 'series_id' => 's', 'original_start' => $at('13:00'), 'starts_at' => $at('13:00'), 'ends_at' => $at('13:30')]);
        // Different occurrences of the same series stay separate.
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'calendar_id' => 'primary', 'external_id' => 'g3', 'title' => 'Weekly 1:1', 'ical_uid' => 'UID-2', 'series_id' => 's', 'original_start' => $at('13:00')->addWeek(), 'starts_at' => $at('13:00')->addWeek(), 'ends_at' => $at('13:30')->addWeek()]);

        $titles = app(CalendarService::class)->occurrences($this->user, $at('00:00'), $at('00:00')->addDays(10))->pluck('title')->all();
        $this->assertSame(['Board meeting', 'Weekly 1:1', 'Weekly 1:1'], $titles);
    }

    public function test_outlook_delta_daylight_saving_and_cancelled_occurrences(): void
    {
        $round = 0;
        Http::fake([
            'graph.microsoft.com/v1.0/me/calendars?*' => Http::response(['value' => [['id' => 'cal', 'name' => 'Calendar', 'isDefaultCalendar' => true]]]),
            'graph.microsoft.com/v1.0/me/calendars/cal/calendarView/delta*' => function () use (&$round) {
                return $round === 0
                    ? Http::response(['value' => [
                        // An all-day event on the DST change day lasts 23 hours in Amsterdam.
                        ['id' => 'dst', 'subject' => 'Spring holiday', 'isAllDay' => true, 'start' => ['dateTime' => '2027-03-28T00:00:00.0000000'], 'end' => ['dateTime' => '2027-03-29T00:00:00.0000000'], 'showAs' => 'oof', 'iCalUId' => 'U-dst'],
                        ['id' => 'occ1', 'subject' => 'Sync', 'start' => ['dateTime' => '2027-03-26T08:00:00.0000000'], 'end' => ['dateTime' => '2027-03-26T08:30:00.0000000'], 'seriesMasterId' => 'm', 'type' => 'occurrence', 'iCalUId' => 'U-s'],
                        ['id' => 'occ2', 'subject' => 'Sync', 'start' => ['dateTime' => '2027-03-29T07:00:00.0000000'], 'end' => ['dateTime' => '2027-03-29T07:30:00.0000000'], 'seriesMasterId' => 'm', 'type' => 'occurrence', 'iCalUId' => 'U-s'],
                    ], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/me/calendars/cal/calendarView/delta?$deltatoken=d1'])
                    : Http::response(['value' => [
                        ['id' => 'occ2', 'subject' => 'Sync', 'isCancelled' => true, 'start' => ['dateTime' => '2027-03-29T07:00:00.0000000'], 'end' => ['dateTime' => '2027-03-29T07:30:00.0000000']],
                        ['id' => 'dst', '@removed' => ['reason' => 'deleted']],
                    ], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/me/calendars/cal/calendarView/delta?$deltatoken=d2']);
            },
        ]);
        $account = $this->account('outlook', ['cal']);
        $sync = app(CalendarSyncService::class);
        $sync->sync($account);

        $holiday = ExternalEvent::where('external_id', 'dst')->first();
        $this->assertSame(['2027-03-27 23:00', '2027-03-28 22:00'], [$holiday->starts_at->format('Y-m-d H:i'), $holiday->ends_at->format('Y-m-d H:i')]);
        // 09:00 Amsterdam before and after the switch: 08:00 UTC, then 07:00 UTC.
        $this->assertSame(['09:00', '09:00'], ExternalEvent::where('title', 'Sync')->orderBy('starts_at')->get()->map(fn ($e) => $e->starts_at->setTimezone('Europe/Amsterdam')->format('H:i'))->all());
        $this->assertSame('m', ExternalEvent::where('external_id', 'occ1')->value('series_id'));

        $round = 1;
        $sync->sync($account->fresh());
        Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'deltatoken=d1'));
        $this->assertSame(['occ1'], ExternalEvent::pluck('external_id')->all(), 'cancelled occurrence and deleted event are removed');
        $this->assertSame(2, SyncRun::latest('id')->value('removed'));
    }

    public function test_task_sync_is_incremental_and_tracks_completion(): void
    {
        $round = 0;
        $requests = [];
        Http::fake([
            'tasks.googleapis.com/tasks/v1/users/@me/lists*' => Http::response(['items' => [['id' => 'L1', 'title' => 'My Tasks']]]),
            'tasks.googleapis.com/tasks/v1/lists/L1/tasks*' => function (HttpRequest $r) use (&$round, &$requests) {
                $requests[] = $r->data();

                return $round === 0
                    ? Http::response(['items' => [['id' => 'a', 'title' => 'File taxes', 'status' => 'needsAction', 'due' => '2027-03-28T00:00:00.000Z'], ['id' => 'b', 'title' => 'Old', 'status' => 'completed', 'completed' => '2027-01-01T10:00:00Z']]])
                    : Http::response(['items' => [['id' => 'a', 'title' => 'File taxes', 'status' => 'completed', 'completed' => '2027-03-22T07:30:00Z'], ['id' => 'c', 'title' => 'Gone', 'deleted' => true]]]);
            },
            'graph.microsoft.com/v1.0/me/todo/lists' => Http::response(['value' => [['id' => 'T', 'displayName' => 'Tasks', 'wellknownListName' => 'defaultList']]]),
            'graph.microsoft.com/v1.0/me/todo/lists/T/tasks/delta*' => fn (HttpRequest $r) => str_contains($r->url(), 'deltatoken')
                ? Http::response(['value' => [['id' => 'm1', '@removed' => ['reason' => 'deleted']]], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/me/todo/lists/T/tasks/delta?$deltatoken=2'])
                : Http::response(['value' => [['id' => 'm1', 'title' => 'Book flights', 'status' => 'notStarted', 'importance' => 'high'], ['id' => 'm2', 'title' => 'Renew visa', 'status' => 'completed', 'completedDateTime' => ['dateTime' => '2027-03-21T18:00:00.0000000', 'timeZone' => 'UTC']]], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/me/todo/lists/T/tasks/delta?$deltatoken=1']),
        ]);
        $sync = app(CalendarSyncService::class);
        $google = $this->account('google_tasks', ['L1']);
        $sync->sync($google);
        $this->assertSame(['File taxes'], ExternalTask::pluck('title')->all(), 'tasks completed long ago are not kept');
        $this->assertArrayNotHasKey('updatedMin', $requests[0]);

        $round = 1;
        $sync->sync($google->fresh());
        $this->assertArrayHasKey('updatedMin', $requests[1]);
        $this->assertSame('true', $requests[1]['showDeleted']);
        $this->assertSame(['completed', '2027-03-22 07:30'], [ExternalTask::sole()->status, ExternalTask::sole()->completed_at->format('Y-m-d H:i')]);

        $todo = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'microsoft_todo', 'external_account_id' => 'm', 'access_token' => 'x', 'refresh_token' => 'r', 'token_expires_at' => now()->addHour(), 'status' => 'active', 'collections' => [['id' => 'T', 'name' => 'Tasks', 'color' => null, 'primary' => true, 'included' => true]]]);
        $sync->sync($todo);
        $this->assertSame(['m1' => 'open', 'm2' => 'completed'], ExternalTask::where('calendar_account_id', $todo->id)->orderBy('external_id')->pluck('status', 'external_id')->all());
        $this->assertSame('high', ExternalTask::where('external_id', 'm1')->value('priority'));
        $sync->sync($todo->fresh());
        $this->assertSame(['m2'], ExternalTask::where('calendar_account_id', $todo->id)->pluck('external_id')->all());
    }

    public function test_failure_back_off_and_observability_without_secrets(): void
    {
        $account = $this->account('google', ['primary'], ['consecutive_failures' => 4, 'last_attempt_at' => now()->subMinutes(90)]);
        $sync = app(CalendarSyncService::class);
        $this->assertFalse($sync->due($account), 'four failures wait two hours');
        $this->travel(31)->minutes();
        $this->assertTrue($sync->due($account->fresh()));

        $this->fakeGoogle(fn () => Http::response(['items' => [$this->event('x', 'Call', '2027-03-23T09:00:00Z', '2027-03-23T09:30:00Z')], 'nextSyncToken' => 'secret-sync-token']));
        $sync->sync($account->fresh(), 'manual');
        $this->assertSame(0, $account->fresh()->consecutive_failures);
        $hub = $this->getJson('/api/integrations')->assertOk();
        $runs = $hub->json('providers.0.accounts.0.recent_runs');
        $this->assertSame(['success', 'manual', 1], [$runs[0]['status'], $runs[0]['trigger'], $runs[0]['upserted']]);
        $this->assertSame('incremental', $hub->json('providers.0.accounts.0.sync_mode'));
        foreach (['secret-sync-token', 'refresh', '"access"'] as $secret) {
            $this->assertStringNotContainsString($secret, $hub->getContent());
        }
    }
}
