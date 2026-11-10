<?php

namespace Tests\Feature\Integrations;

use App\Integrations\OAuth\OAuthStateStore;
use App\Integrations\Permissions\ConnectionPermissions;
use App\Integrations\Sync\OutboundSync;
use App\Integrations\Sync\SyncRunPruner;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\InboxNotification;
use App\Models\OauthState;
use App\Models\SyncConflict;
use App\Models\SyncRun;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Bounded history (sync runs, OAuth states), a hub that costs the same few queries however many accounts there are, and the write grant that a read-only reconnect must clear.
 */
class RetentionTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-22 08:00:00', 'UTC'));
        config([
            'calendar_write.enabled' => true, 'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
        ]);
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
    }

    private function account(string $external = 'g-1', ?User $user = null): CalendarAccount
    {
        return CalendarAccount::create(['user_id' => ($user ?? $this->user)->id, 'provider' => 'google', 'external_account_id' => $external, 'email' => "{$external}@gmail.com", 'access_token' => 'tok', 'refresh_token' => 'r',
            'token_expires_at' => now()->addHour(), 'scopes' => 'openid https://www.googleapis.com/auth/calendar.readonly', 'status' => 'active', 'collections' => []]);
    }

    private function runs(CalendarAccount $account, int $count, string $olderThanDays, string $trigger = 'scheduled'): void
    {
        $rows = [];
        for ($i = 0; $i < $count; $i++) {
            $rows[] = ['user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'mode' => 'full', 'status' => 'ok', 'trigger' => $trigger,
                'started_at' => now()->subDays((int) $olderThanDays)->subMinutes($count - $i)->toDateTimeString()];
        }
        foreach (array_chunk($rows, 400) as $chunk) {
            SyncRun::insert($chunk);
        }
    }

    public function test_pruning_keeps_the_newest_twenty_per_account_deletes_only_old_rows_and_is_idempotent(): void
    {
        config(['integrations.sync_run_retention_days' => 30]);
        $busy = $this->account('busy');
        $quiet = $this->account('quiet');
        $this->runs($busy, 2100, '40');   // all old
        $this->runs($busy, 30, '1');      // recent
        $this->runs($quiet, 5, '60');     // old, but fewer than 20 in total
        $newestBusy = SyncRun::where('calendar_account_id', $busy->id)->orderByDesc('id')->limit(20)->pluck('id')->all();

        $deleted = app(SyncRunPruner::class)->prune();

        $this->assertSame(2100, $deleted);
        $this->assertSame(30, SyncRun::where('calendar_account_id', $busy->id)->count());
        $this->assertSame(5, SyncRun::where('calendar_account_id', $quiet->id)->count());
        $this->assertEmpty(array_diff($newestBusy, SyncRun::where('calendar_account_id', $busy->id)->pluck('id')->all()));
        $this->assertSame(0, app(SyncRunPruner::class)->prune());
        $this->assertSame(35, SyncRun::count());
    }

    public function test_an_account_whose_runs_are_all_old_still_keeps_its_newest_twenty(): void
    {
        $account = $this->account();
        $this->runs($account, 1500, '90');
        $newest = SyncRun::orderByDesc('id')->limit(20)->pluck('id')->all();

        $this->assertSame(1480, app(SyncRunPruner::class)->prune());
        $this->assertEqualsCanonicalizing($newest, SyncRun::pluck('id')->all());
        $this->artisan('lifeos:integrations:prune')->assertSuccessful();
        $this->assertSame(20, SyncRun::count());
    }

    public function test_oauth_prune_removes_expired_and_used_states_and_keeps_live_ones(): void
    {
        $store = app(OAuthStateStore::class);
        $live = $store->begin($this->user, 'google');
        $used = $store->begin($this->user, 'google');
        $store->consume($used['state'], $this->user, 'google');          // consumed, but still inside the grace hour
        $expired = $store->begin($this->user, 'google');
        OauthState::where('state_hash', hash('sha256', $expired['state']))->update(['expires_at' => now()->subHours(3)]);
        OauthState::where('state_hash', hash('sha256', $used['state']))->update(['expires_at' => now()->subHours(2)]);
        $this->assertSame(3, OauthState::count());

        $this->assertSame(2, $store->prune());
        $this->assertSame([hash('sha256', $live['state'])], OauthState::pluck('state_hash')->all());
        $this->assertSame(0, $store->prune());
    }

    public function test_the_hub_shows_the_recent_runs_of_a_quiet_account_even_when_another_has_hundreds(): void
    {
        $busy = $this->account('busy');
        $quiet = $this->account('quiet');
        $this->runs($quiet, 3, '3');
        $this->runs($busy, 260, '0');   // all newer than the quiet account's

        $accounts = collect($this->getJson('/api/integrations')->assertOk()->json('providers.0.accounts'))->keyBy('id');

        $this->assertCount(5, $accounts[$busy->id]['recent_runs']);
        $this->assertCount(3, $accounts[$quiet->id]['recent_runs']);
        $this->assertSame(SyncRun::where('calendar_account_id', $busy->id)->max('id'), $accounts[$busy->id]['recent_runs'][0]['id']);
    }

    private function hubQueries(): int
    {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $this->getJson('/api/integrations')->assertOk();
        $count = count(DB::getQueryLog());
        DB::disableQueryLog();

        return $count;
    }

    public function test_the_hub_costs_the_same_queries_for_five_accounts_as_for_one_and_reports_the_same_facts(): void
    {
        $first = $this->account('a1');
        $event = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
        $this->runs($first, 2, '0', 'outbound');
        CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $first->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'c', 'external_id' => 'x1', 'etag' => 'e',
            'title' => 'Deep work', 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at]);
        $this->getJson('/api/integrations')->assertOk();   // warm the per-process provider caches
        $one = $this->hubQueries();

        $accounts = [$first];
        for ($i = 2; $i <= 5; $i++) {
            $accounts[] = $a = $this->account("a{$i}");
            $this->runs($a, 7, '0', 'outbound');
            $link = CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $a->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'c', 'external_id' => "x{$i}", 'etag' => 'e',
                'title' => $i === 3 ? 'Old title' : 'Deep work', 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at]);
            SyncConflict::create(['user_id' => $this->user->id, 'calendar_account_id' => $a->id, 'calendar_write_link_id' => $link->id, 'local_title' => 'x']);
        }
        $five = $this->hubQueries();

        $this->assertSame($one, $five);
        $this->assertLessThanOrEqual(30, $five);
        $byId = collect($this->getJson('/api/integrations')->json('providers.0.accounts'))->keyBy('id');
        $this->assertSame(['copies' => 1, 'copies_pending' => 1, 'open_conflicts' => 1], collect($byId[$accounts[2]->id]['sync'])->only(['copies', 'copies_pending', 'open_conflicts'])->all());
        $this->assertSame(['copies' => 1, 'copies_pending' => 0, 'open_conflicts' => 1], collect($byId[$accounts[1]->id]['sync'])->only(['copies', 'copies_pending', 'open_conflicts'])->all());
        $this->assertSame(['copies' => 1, 'copies_pending' => 0, 'open_conflicts' => 0], collect($byId[$first->id]['sync'])->only(['copies', 'copies_pending', 'open_conflicts'])->all());
        $this->assertSame(SyncRun::where('calendar_account_id', $accounts[1]->id)->max('id'), $byId[$accounts[1]->id]['sync']['last_outbound']['id']);
        $this->assertSame(SyncRun::where('calendar_account_id', $first->id)->max('id'), $byId[$first->id]['sync']['last_outbound']['id']);
        $this->assertSame(1, $this->getJson('/api/integrations')->json('providers.0.accounts.1.write.copies'));
    }

    public function test_a_read_only_reconnect_clears_the_write_grant_but_a_write_reconnect_keeps_it(): void
    {
        $scope = 'openid https://www.googleapis.com/auth/calendar.readonly';
        Http::fake([
            'oauth2.googleapis.com/token' => function () use (&$scope) {
                return Http::response(['access_token' => 'new-token', 'refresh_token' => 'r2', 'expires_in' => 3600, 'scope' => $scope]);
            },
            'openidconnect.googleapis.com/*' => Http::response(['sub' => 'g-1', 'email' => 'g-1@gmail.com', 'name' => 'Me']),
            'www.googleapis.com/calendar/v3/*' => Http::response(['items' => []]),
        ]);
        $account = $this->account('g-1');
        $grant = fn () => $account->forceFill(['write_granted_at' => now(), 'write_calendar_id' => 'work@group', 'write_calendar_name' => 'Work'])->save();
        $reconnect = function () {
            $url = $this->postJson('/api/integrations/google/connect')->assertOk()->json('authorization_url');
            parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

            return $this->get('/api/integrations/google/callback?code=c&state='.$query['state']);
        };

        $grant();
        $scope .= ' https://www.googleapis.com/auth/calendar.events';
        $reconnect()->assertRedirect('https://app.lifeos.test/settings/integrations?connected=google');
        $this->assertNotNull($account->fresh()->write_granted_at);
        $this->assertSame('work@group', $account->fresh()->write_calendar_id);

        $scope = 'openid https://www.googleapis.com/auth/calendar.readonly';
        $reconnect()->assertRedirect('https://app.lifeos.test/settings/integrations?connected=google');
        $fresh = $account->fresh();
        $this->assertNull($fresh->write_granted_at);
        $this->assertNull($fresh->write_calendar_id);
        $this->assertNull($fresh->write_calendar_name);
        $this->assertSame('new-token', $fresh->access_token);
        $write = collect($this->getJson('/api/integrations')->json('providers.0.accounts'))->firstWhere('id', $account->id)['write'];
        $this->assertFalse($write['granted']);
        $this->assertFalse($write['enabled']);
    }

    public function test_a_reconnect_whose_token_response_reports_no_scopes_keeps_the_write_grant(): void
    {
        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'new-token', 'refresh_token' => 'r2', 'expires_in' => 3600]),
            'openidconnect.googleapis.com/*' => Http::response(['sub' => 'g-1', 'email' => 'g-1@gmail.com', 'name' => 'Me']),
            'www.googleapis.com/calendar/v3/*' => Http::response(['items' => []]),
        ]);
        $account = $this->account('g-1');
        $account->forceFill(['write_granted_at' => now(), 'write_calendar_id' => 'work@group', 'write_calendar_name' => 'Work'])->save();
        $url = $this->postJson('/api/integrations/google/connect')->assertOk()->json('authorization_url');
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        $this->get('/api/integrations/google/callback?code=c&state='.$query['state'])->assertRedirect();

        $fresh = $account->fresh();
        $this->assertSame('new-token', $fresh->access_token);
        $this->assertNotNull($fresh->write_granted_at);
        $this->assertSame(['work@group', 'Work'], [$fresh->write_calendar_id, $fresh->write_calendar_name]);
    }

    private function outboundReady(): CalendarWriteLink
    {
        $account = $this->account('out');
        $account->forceFill(['sync_direction' => 'outbound', 'token_expires_at' => now()->subMinute(), 'scopes' => 'openid calendar.readonly', 'write_granted_at' => now(), 'write_calendar_id' => 'work@group',
            'write_calendar_name' => 'Work', 'permissions' => ConnectionPermissions::PRESETS['read_create_update']])->save();
        $event = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Renamed in LifeOS', 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);

        return CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'work@group',
            'external_id' => 'lifeos123', 'etag' => '"e1"', 'title' => 'Old title', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
    }

    public function test_a_rate_limited_token_refresh_during_an_outbound_run_makes_the_account_wait_and_finishes_the_run(): void
    {
        $link = $this->outboundReady();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'unavailable'], 503, ['Retry-After' => '90'])]);

        $result = app(OutboundSync::class)->run(CalendarAccount::findOrFail($link->calendar_account_id));

        $account = CalendarAccount::findOrFail($link->calendar_account_id);
        $this->assertTrue($result['ran']);
        $this->assertTrue($account->retry_after->isFuture());
        $this->assertGreaterThanOrEqual(30, (int) now()->diffInSeconds($account->retry_after));
        $this->assertSame('active', $account->status);
        $run = SyncRun::where('trigger', 'outbound')->sole();
        $this->assertSame('rate_limited', $run->status);
        $this->assertNotNull($run->finished_at);
        $this->assertSame(0, InboxNotification::where('user_id', $this->user->id)->count());
        $this->assertSame('Old title', $link->fresh()->title);
        Http::assertNotSent(fn ($request) => str_contains($request->url(), 'www.googleapis.com/calendar'));
    }

    public function test_a_failing_token_refresh_during_an_outbound_run_fails_the_run_without_revoking_or_notifying(): void
    {
        foreach ([[503, []], [500, []]] as [$status, $headers]) {
            SyncRun::query()->delete();
            CalendarAccount::query()->delete();
            $link = $this->outboundReady();
            Http::fake(['oauth2.googleapis.com/*' => Http::response(['error' => 'boom'], $status, $headers)]);

            app(OutboundSync::class)->run(CalendarAccount::findOrFail($link->calendar_account_id));

            $this->assertSame('active', CalendarAccount::findOrFail($link->calendar_account_id)->status);
            $run = SyncRun::where('trigger', 'outbound')->sole();
            $this->assertSame('failed', $run->status);
            $this->assertNotNull($run->finished_at);
            $this->assertNotNull($run->error);
            $this->assertSame(0, InboxNotification::where('user_id', $this->user->id)->count());
            $this->assertSame('Old title', $link->fresh()->title);
        }
    }

    public function test_a_refresh_answer_without_an_access_token_fails_the_run(): void
    {
        $link = $this->outboundReady();
        Http::fake(['oauth2.googleapis.com/*' => Http::response(['expires_in' => 3600], 200)]);

        app(OutboundSync::class)->run(CalendarAccount::findOrFail($link->calendar_account_id));

        $this->assertSame('failed', SyncRun::where('trigger', 'outbound')->sole()->status);
        $this->assertSame('active', CalendarAccount::findOrFail($link->calendar_account_id)->status);
    }
}
