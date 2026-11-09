<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Permissions\ConnectionPermissions;
use App\Integrations\Sync\OutboundSync;
use App\Jobs\PushOutboundChanges;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\SyncConflict;
use App\Models\SyncRun;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Synchronisation direction, conflict policy and the outbound run, on the existing engine: nothing is sent unless the direction and the person's permissions both say so, only
 * existing copies are ever updated, nothing is created or deleted by itself, and every failure is isolated, recorded and non-destructive. Providers are faked; no real account is written.
 */
class SyncEngineTest extends TestCase
{
    use RefreshDatabase;

    private const EVENT_URL = 'www.googleapis.com/calendar/v3/calendars/work%40group/events/*';

    private User $user;

    private CalendarAccount $google;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-22 08:00:00', 'UTC'));
        config(['calendar_write.enabled' => true, 'app.frontend_url' => 'https://app.lifeos.test',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.todoist' => ['client_id' => 'tid', 'client_secret' => 'tsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/todoist/callback']]);
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->google = $this->account($this->user, 'g-1', ConnectionPermissions::PRESETS['read_create_update']);
        $this->actingAs($this->user)->withSession(['auth.password_confirmed_at' => now()->getTimestamp()]);
    }

    private function account(User $user, string $id, array $permissions, string $provider = 'google'): CalendarAccount
    {
        return CalendarAccount::create(['user_id' => $user->id, 'provider' => $provider, 'external_account_id' => $id, 'email' => "{$id}@example.test", 'access_token' => 'tok', 'refresh_token' => 'r',
            'token_expires_at' => now()->addHour(), 'scopes' => 'openid calendar.readonly', 'status' => 'active', 'collections' => [], 'write_granted_at' => now(), 'write_calendar_id' => 'work@group',
            'write_calendar_name' => 'Work', 'permissions' => $permissions]);
    }

    /** A LifeOS event with a copy at the service that no longer matches it (the title was changed in LifeOS). */
    private function stale(string $externalId = 'lifeos123', ?CalendarAccount $account = null, string $title = 'Renamed in LifeOS'): CalendarWriteLink
    {
        $account ??= $this->google;
        $event = CalendarEvent::create(['user_id' => $account->user_id, 'title' => $title, 'kind' => 'flexible', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);

        return CalendarWriteLink::create(['user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'work@group',
            'external_id' => $externalId, 'etag' => '"e1"', 'title' => 'Old title', 'starts_at' => '2027-03-23 09:00:00', 'ends_at' => '2027-03-23 11:00:00']);
    }

    private function direction(string $direction, ?CalendarAccount $account = null): void
    {
        ($account ?? $this->google)->forceFill(['sync_direction' => $direction])->save();
    }

    /** @return list<HttpRequest> */
    private function sent(?string $method = null): array
    {
        return collect(Http::recorded())->map(fn ($pair) => $pair[0])->filter(fn (HttpRequest $r) => $r->method() !== 'GET' && ($method === null || $r->method() === $method))->values()->all();
    }

    private function push(?CalendarAccount $account = null, bool $dry = false): array
    {
        return app(OutboundSync::class)->run(($account ?? $this->google)->fresh(), $dry);
    }

    // ---- settings ----

    public function test_every_existing_connection_keeps_todays_behaviour(): void
    {
        $fresh = CalendarAccount::find($this->google->id);
        $this->assertSame(['inbound', 'ask', null], [$fresh->sync_direction, $fresh->conflict_policy, $fresh->sync_paused_at]);
        $sync = collect($this->getJson('/api/integrations')->assertOk()->json('providers'))->firstWhere('provider', 'google')['accounts'][0]['sync'];
        $this->assertSame(['inbound', 'inbound', null, 'ask', false, 0, 0], [$sync['direction'], $sync['effective_direction'], $sync['effective_reason'], $sync['conflict_policy'], $sync['paused'], $sync['copies'], $sync['open_conflicts']]);
        $this->assertSame(['inbound', 'outbound', 'two_way', 'manual'], $sync['available_directions']);
    }

    public function test_a_service_that_cannot_be_sent_changes_offers_only_what_it_can_do(): void
    {
        $todoist = $this->account($this->user, 't-1', ['read', 'sync', 'import'], 'todoist');
        $url = "/api/integrations/accounts/{$todoist->id}/sync-settings";
        $this->putJson($url, ['direction' => 'two_way'])->assertUnprocessable()->assertJsonPath('code', 'direction_not_available');
        $this->putJson($url, ['direction' => 'outbound'])->assertUnprocessable();
        $this->putJson($url, ['direction' => 'manual'])->assertOk()->assertJsonPath('data.direction', 'manual')->assertJsonPath('data.available_directions', ['inbound', 'manual']);
    }

    public function test_choosing_a_direction_and_a_policy_is_validated_audited_once_and_private(): void
    {
        $url = "/api/integrations/accounts/{$this->google->id}/sync-settings";
        $this->putJson($url, ['direction' => 'sideways'])->assertUnprocessable();
        $this->putJson($url, ['conflict_policy' => 'whatever'])->assertUnprocessable();
        $this->putJson($url, [])->assertUnprocessable();
        $this->putJson($url, ['direction' => 'two_way', 'conflict_policy' => 'prefer_external'])->assertOk()->assertJsonPath('data.direction', 'two_way')->assertJsonPath('data.conflict_policy', 'prefer_external');
        $this->assertSame(1, AuditLog::where('action', 'integration_sync_settings_changed')->count());
        $this->assertSame(['provider' => 'google', 'account_id' => $this->google->id, 'direction' => 'two_way', 'conflict_policy' => 'prefer_external'], AuditLog::where('action', 'integration_sync_settings_changed')->sole()->meta);
        $this->putJson($url, ['direction' => 'two_way'])->assertOk();
        $this->assertSame(1, AuditLog::where('action', 'integration_sync_settings_changed')->count(), 'a repeat that changes nothing is not logged');

        $other = User::factory()->create();
        $theirs = $this->account($other, 'g-9', ConnectionPermissions::PRESETS['full']);
        $this->putJson("/api/integrations/accounts/{$theirs->id}/sync-settings", ['direction' => 'two_way'])->assertNotFound();
        $this->postJson("/api/integrations/accounts/{$theirs->id}/sync/preview")->assertNotFound();
        $this->postJson("/api/integrations/accounts/{$theirs->id}/sync/push")->assertNotFound();
        $this->getJson("/api/integrations/accounts/{$theirs->id}/sync-conflicts")->assertNotFound();
        $this->assertSame('inbound', $theirs->fresh()->sync_direction);

        $this->flushSession();
        $this->putJson($url, ['direction' => 'manual'])->assertStatus(423);
        $this->assertSame('two_way', $this->google->fresh()->sync_direction);
    }

    public function test_pausing_stops_the_schedule_and_resuming_brings_it_back(): void
    {
        $url = "/api/integrations/accounts/{$this->google->id}/sync-settings";
        $sync = app(CalendarSyncService::class);
        $this->assertTrue($sync->due($this->google->fresh()));
        $this->putJson($url, ['paused' => true])->assertOk()->assertJsonPath('data.paused', true);
        $this->assertFalse($sync->due($this->google->fresh()));
        $this->putJson($url, ['paused' => false])->assertOk()->assertJsonPath('data.paused', false);
        $this->assertTrue($sync->due($this->google->fresh()));
    }

    // ---- direction decides what runs on the schedule ----

    public function test_the_direction_decides_what_the_scheduler_does(): void
    {
        $sync = app(CalendarSyncService::class);
        Http::fake();
        foreach (['inbound' => true, 'two_way' => true, 'outbound' => false, 'manual' => false] as $direction => $reads) {
            $this->direction($direction);
            $this->assertSame($reads, $sync->due($this->google->fresh()), "{$direction}: scheduled reading");
            if (! $reads) {
                $this->assertSame(0, $sync->sync($this->google->fresh(), 'scheduled'), 'a run queued earlier does nothing');
            }
        }
        Http::assertNothingSent();
        // "Sync now" is the person asking: it reads even with direction manual.
        $this->direction('manual');
        Http::fake(['www.googleapis.com/*' => Http::response(['items' => []]), 'oauth2.googleapis.com/*' => Http::response([])]);
        $sync->sync($this->google->fresh(), 'manual');
        $this->assertGreaterThan(0, SyncRun::where('trigger', 'manual')->count());
    }

    public function test_only_connections_that_send_and_are_allowed_to_are_queued_for_outbound(): void
    {
        Queue::fake();
        $this->direction('outbound');
        $readOnly = $this->account($this->user, 'g-2', ['read', 'sync']);
        $this->direction('two_way', $readOnly);
        $paused = $this->account($this->user, 'g-3', ConnectionPermissions::PRESETS['full']);
        $this->direction('outbound', $paused);
        $paused->forceFill(['sync_paused_at' => now()])->save();
        $inbound = $this->account($this->user, 'g-4', ConnectionPermissions::PRESETS['full']);
        $this->artisan('lifeos:sync-outbound')->expectsOutputToContain('Queued 1')->assertSuccessful();
        Queue::assertPushed(PushOutboundChanges::class, fn ($job) => $job->accountId === $this->google->id);
        Queue::assertPushedTimes(PushOutboundChanges::class, 1);
        $this->assertSame('inbound', $inbound->fresh()->sync_direction);
    }

    public function test_two_way_with_read_only_permissions_sends_nothing_and_says_why(): void
    {
        Http::fake();
        $this->direction('two_way');
        $this->google->forceFill(['permissions' => ['read', 'sync']])->save();
        $this->stale();
        $sync = $this->getJson('/api/integrations')->json('providers.0.accounts.0.sync');
        $this->assertSame(['two_way', 'inbound', 'permissions'], [$sync['direction'], $sync['effective_direction'], $sync['effective_reason']]);
        $this->assertFalse($this->push()['ran']);
        $this->postJson("/api/integrations/accounts/{$this->google->id}/sync/push")->assertForbidden()->assertJsonPath('code', 'permission_denied');
        Http::assertNothingSent();
        $this->assertSame(0, SyncRun::where('trigger', 'outbound')->count());
    }

    // ---- the outbound run ----

    public function test_it_updates_copies_that_fell_behind_and_nothing_else_and_a_second_run_sends_nothing(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['id' => 'lifeos123', 'etag' => '"e2"'])]);
        $this->direction('outbound');
        $link = $this->stale();
        $current = $this->stale('lifeos456', null, 'Same as there');
        $current->forceFill(['title' => 'Same as there'])->save();   // already matches its event
        $orphan = CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->google->id, 'calendar_event_id' => null, 'calendar_id' => 'work@group',
            'external_id' => 'orphan1', 'etag' => '"o"', 'title' => 'Event removed from LifeOS', 'starts_at' => '2027-03-24 09:00:00', 'ends_at' => '2027-03-24 10:00:00']);

        $result = $this->push();
        $this->assertSame([true, 1, 0], [$result['ran'], $result['pushed'], $result['failed']]);
        $sent = $this->sent();
        $this->assertCount(1, $sent);
        $this->assertSame('PATCH', $sent[0]->method());
        $this->assertSame('Renamed in LifeOS', $sent[0]['summary']);
        $this->assertSame('"e1"', $sent[0]->header('If-Match')[0], 'an edit made at the service is never overwritten');
        $this->assertSame(['Renamed in LifeOS', '"e2"'], [$link->fresh()->title, $link->fresh()->etag]);
        $this->assertNotNull(CalendarWriteLink::find($orphan->id), 'a copy whose LifeOS event is gone is left for the person to remove');
        $this->assertSame(0, count($this->sent('DELETE')) + count($this->sent('POST')), 'nothing is ever created or deleted by itself');

        $again = $this->push();
        $this->assertSame([0, 0], [$again['pushed'], $again['pending']]);
        $this->assertCount(1, $this->sent(), 'idempotent: the second run sent nothing');
        $run = SyncRun::where('trigger', 'outbound')->orderBy('id')->first();
        $this->assertSame(['success', 1, 0], [$run->status, $run->upserted, $run->removed]);
        $this->assertSame(1, $run->details['pushed']);
    }

    public function test_a_dry_run_changes_nothing_anywhere(): void
    {
        Http::fake();
        $this->direction('outbound');
        $link = $this->stale();
        $result = $this->push(dry: true);
        $this->assertSame([false, 1], [$result['ran'] && false, $result['pending']]);
        $this->assertSame([['link_id' => $link->id, 'event_id' => $link->calendar_event_id, 'from' => 'Old title', 'to' => 'Renamed in LifeOS']], $result['planned']);
        Http::assertNothingSent();
        $this->assertSame(0, SyncRun::count());
        $this->assertSame('Old title', $link->fresh()->title);
        $this->postJson("/api/integrations/accounts/{$this->google->id}/sync/preview")->assertOk()->assertJsonPath('data.pending', 1)->assertJsonPath('data.planned.0.to', 'Renamed in LifeOS');
        Http::assertNothingSent();
    }

    public function test_one_run_sends_at_most_a_batch_and_the_rest_waits_for_the_next(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['id' => 'x', 'etag' => '"n"'])]);
        $this->direction('outbound');
        foreach (range(1, OutboundSync::BATCH + 5) as $i) {
            $this->stale("copy{$i}", null, "Event {$i}");
        }
        $first = $this->push();
        $this->assertSame([OutboundSync::BATCH, OutboundSync::BATCH + 5], [$first['pushed'], $first['pending']]);
        $second = $this->push();
        $this->assertSame([5, 5], [$second['pushed'], $second['pending']]);
    }

    public function test_failures_are_isolated_and_the_run_is_recorded_as_partial(): void
    {
        Http::fake([
            'www.googleapis.com/calendar/v3/calendars/work%40group/events/bad' => Http::response(['error' => ['code' => 500]], 500),
            self::EVENT_URL => Http::response(['id' => 'x', 'etag' => '"n"']),
        ]);
        $this->direction('outbound');
        $bad = $this->stale('bad', null, 'Fails');
        $good = $this->stale('good', null, 'Works');
        $result = $this->push();
        $this->assertSame([1, 1], [$result['pushed'], $result['failed']]);
        $this->assertSame('Old title', $bad->fresh()->title, 'a failed copy is untouched and will be tried again');
        $this->assertSame('Works', $good->fresh()->title);
        $this->assertSame('partial', SyncRun::where('trigger', 'outbound')->sole()->status);
        $this->assertSame('active', $this->google->fresh()->status);
    }

    public function test_a_copy_removed_at_the_service_is_forgotten_never_deleted_or_recreated(): void
    {
        Http::fake([self::EVENT_URL => Http::response([], 404)]);
        $this->direction('outbound');
        $link = $this->stale();
        $result = $this->push();
        $this->assertSame(1, $result['gone']);
        $this->assertNull(CalendarWriteLink::find($link->id));
        $this->assertNotNull(CalendarEvent::find($link->calendar_event_id), 'the LifeOS event is untouched');
        $this->assertSame([], array_merge($this->sent('DELETE'), $this->sent('POST')));
    }

    public function test_a_rate_limit_stops_the_run_and_the_account_waits(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 429]], 429, ['Retry-After' => '120'])]);
        $this->direction('outbound');
        $this->stale('a');
        $this->stale('b');
        $result = $this->push();
        $this->assertSame(0, $result['pushed']);
        $this->assertCount(1, $this->sent(), 'it stopped at the first sign of a limit');
        $this->assertTrue($this->google->fresh()->retry_after->isFuture());
        $this->assertSame('rate_limited', SyncRun::where('trigger', 'outbound')->sole()->status);
        $this->artisan('lifeos:sync-outbound')->expectsOutputToContain('Queued 0')->assertSuccessful();   // not asked again until the wait is over
    }

    public function test_revoked_access_ends_the_run_and_marks_the_account(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 401]], 401)]);
        $this->direction('outbound');
        $this->stale();
        $this->push();
        $this->assertSame('revoked', $this->google->fresh()->status);
        $this->assertFalse($this->push()['ran'], 'a revoked account is not tried again');
    }

    public function test_the_person_turning_updating_off_mid_run_stops_it(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['id' => 'x', 'etag' => '"n"'])]);
        $this->direction('outbound');
        $this->stale();
        $this->google->forceFill(['permissions' => ConnectionPermissions::PRESETS['read_create']])->save();   // no update
        $this->assertFalse($this->push()['ran']);
        Http::assertNothingSent();
    }

    // ---- conflicts ----

    private function conflicting(): CalendarWriteLink
    {
        $this->direction('outbound');

        return $this->stale();
    }

    public function test_asking_is_the_default_the_conflict_is_recorded_once_and_nothing_is_overwritten(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 412]], 412)]);
        $link = $this->conflicting();
        $first = $this->push();
        $this->assertSame([0, 1, 1], [$first['pushed'], $first['conflicts'], $first['awaiting']]);
        $this->assertSame('open', SyncConflict::sole()->status);
        $this->assertSame('Renamed in LifeOS', SyncConflict::sole()->local_title);
        $second = $this->push();
        $this->assertSame([0, 0, 1], [$second['pushed'], $second['conflicts'], $second['awaiting']]);
        $this->assertSame(1, SyncConflict::count(), 'the same conflict is not recorded twice');
        $this->assertCount(1, $this->sent(), 'while it waits, nothing more is sent for that copy');
        $this->assertSame('Old title', $link->fresh()->title);
        $this->assertSame(1, $this->getJson('/api/integrations')->json('providers.0.accounts.0.sync.open_conflicts'));
        $this->getJson("/api/integrations/accounts/{$this->google->id}/sync-conflicts")->assertOk()->assertJsonPath('data.0.status', 'open')->assertJsonPath('data.0.title', 'Renamed in LifeOS');
    }

    public function test_keeping_what_is_at_the_service_writes_nothing(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 412]], 412)]);
        $link = $this->conflicting();
        $this->push();
        $before = count($this->sent());
        $this->postJson('/api/integrations/sync-conflicts/'.SyncConflict::sole()->id.'/resolve', ['resolution' => 'keep_external'])->assertOk()->assertJsonPath('data.resolution', 'keep_external');
        $this->assertCount($before, $this->sent());
        $this->assertTrue($link->fresh()->inSync(), 'LifeOS stops trying to send this version');
        $this->assertSame('resolved', SyncConflict::sole()->status);
        $this->assertSame(['account_id' => $this->google->id, 'resolution' => 'keep_external', 'by' => 'person'], AuditLog::where('action', 'sync_conflict_resolved')->sole()->meta);
        $this->postJson('/api/integrations/sync-conflicts/'.SyncConflict::sole()->id.'/resolve', ['resolution' => 'keep_external'])->assertOk();
        $this->assertSame(1, AuditLog::where('action', 'sync_conflict_resolved')->count(), 'resolving twice is not logged twice');
    }

    public function test_overwriting_the_service_needs_an_explicit_confirmation_and_sends_no_etag(): void
    {
        Http::fake([self::EVENT_URL => Http::sequence()->push(['error' => ['code' => 412]], 412)->push(['id' => 'lifeos123', 'etag' => '"e9"'])]);
        $link = $this->conflicting();
        $this->push();
        $id = SyncConflict::sole()->id;
        $this->postJson("/api/integrations/sync-conflicts/{$id}/resolve", ['resolution' => 'keep_lifeos'])->assertUnprocessable()->assertJsonPath('code', 'overwrite_confirmation_required');
        $this->assertCount(1, $this->sent());
        $this->postJson("/api/integrations/sync-conflicts/{$id}/resolve", ['resolution' => 'keep_lifeos', 'confirm_overwrite' => true])->assertOk();
        $this->assertCount(2, $this->sent());
        $this->assertSame([], $this->sent('PATCH')[1]->header('If-Match'), 'the person chose to overwrite what is there');
        $this->assertSame(['Renamed in LifeOS', '"e9"'], [$link->fresh()->title, $link->fresh()->etag]);
    }

    public function test_keeping_both_adds_a_new_copy_and_leaves_the_one_there_alone(): void
    {
        Http::fake([
            'www.googleapis.com/calendar/v3/calendars/work%40group/events/lifeos123' => Http::response(['error' => ['code' => 412]], 412),
            'www.googleapis.com/calendar/v3/calendars/work%40group/events' => Http::response(['id' => 'newcopy', 'etag' => '"n1"']),
        ]);
        $link = $this->conflicting();
        $this->push();
        $this->postJson('/api/integrations/sync-conflicts/'.SyncConflict::sole()->id.'/resolve', ['resolution' => 'keep_both'])->assertOk();
        $this->assertCount(1, $this->sent('POST'));
        $this->assertCount(0, $this->sent('DELETE'), 'the one at the service is never deleted');
        $this->assertNull(CalendarWriteLink::find($link->id), 'LifeOS no longer manages the old one');
        $this->assertSame('newcopy', CalendarWriteLink::sole()->external_id);
    }

    public function test_keeping_both_that_fails_at_the_service_changes_nothing_in_lifeos(): void
    {
        Http::fake([
            'www.googleapis.com/calendar/v3/calendars/work%40group/events/lifeos123' => Http::response(['error' => ['code' => 412]], 412),
            'www.googleapis.com/calendar/v3/calendars/work%40group/events' => Http::response(['error' => ['code' => 500]], 500),
        ]);
        $link = $this->conflicting();
        $this->push();
        $this->postJson('/api/integrations/sync-conflicts/'.SyncConflict::sole()->id.'/resolve', ['resolution' => 'keep_both'])->assertUnprocessable();
        $this->assertNotNull(CalendarWriteLink::find($link->id), 'the link to the existing copy is still there');
        $this->assertSame(1, CalendarWriteLink::count());
        $this->assertSame('open', SyncConflict::sole()->status);
    }

    public function test_a_resolution_the_permissions_do_not_allow_is_refused_and_the_conflict_stays_open(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 412]], 412)]);
        $this->conflicting();
        $this->push();
        $before = count($this->sent());
        $this->google->forceFill(['permissions' => ['read', 'sync', 'export', 'update']])->save();   // update but no create
        $this->postJson('/api/integrations/sync-conflicts/'.SyncConflict::sole()->id.'/resolve', ['resolution' => 'keep_both'])->assertForbidden()->assertJsonPath('operation', 'create');
        $this->assertCount($before, $this->sent());
        $this->assertSame('open', SyncConflict::sole()->status);
    }

    /** @return array<string, array{string, int, int, string}> */
    public static function policies(): array
    {
        return ['prefer_external' => ['prefer_external', 0, 0, 'keep_external'], 'prefer_lifeos' => ['prefer_lifeos', 1, 0, 'keep_lifeos'], 'keep_both' => ['keep_both', 0, 1, 'keep_both']];
    }

    #[DataProvider('policies')]
    public function test_a_standing_policy_settles_a_conflict_the_way_the_person_chose(string $policy, int $patches, int $posts, string $resolution): void
    {
        Http::fake([
            'www.googleapis.com/calendar/v3/calendars/work%40group/events/lifeos123' => Http::sequence()->push(['error' => ['code' => 412]], 412)->push(['id' => 'lifeos123', 'etag' => '"e9"']),
            'www.googleapis.com/calendar/v3/calendars/work%40group/events' => Http::response(['id' => 'newcopy', 'etag' => '"n1"']),
        ]);
        $this->google->forceFill(['permissions' => ConnectionPermissions::PRESETS['read_create_update'], 'conflict_policy' => $policy])->save();
        $this->conflicting();
        $result = $this->push();
        $this->assertSame([1, 0], [$result['conflicts'], $result['awaiting']]);
        $this->assertSame([$resolution, 'resolved'], [SyncConflict::sole()->resolution, SyncConflict::sole()->status]);
        $this->assertCount(1 + $patches, $this->sent('PATCH'));
        $this->assertCount($posts, $this->sent('POST'));
        $this->assertCount(0, $this->sent('DELETE'));
        $this->assertSame('policy', AuditLog::where('action', 'sync_conflict_resolved')->sole()->meta['by']);
    }

    public function test_a_policy_that_cannot_be_carried_out_leaves_the_conflict_open(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 412]], 412)]);
        $this->google->forceFill(['permissions' => ConnectionPermissions::PRESETS['read_create_update'], 'conflict_policy' => 'keep_both', 'write_calendar_id' => null])->save();   // no calendar to add to
        $this->conflicting();
        $result = $this->push();
        $this->assertSame([1, 1], [$result['conflicts'], $result['awaiting']]);
        $this->assertSame('open', SyncConflict::sole()->status);
    }

    // ---- privacy ----

    public function test_conflicts_and_runs_belong_to_their_owner_only(): void
    {
        Http::fake([self::EVENT_URL => Http::response(['error' => ['code' => 412]], 412)]);
        $this->conflicting();
        $this->push();
        $this->actingAs(User::factory()->create())->withSession(['auth.password_confirmed_at' => now()->getTimestamp()]);
        $this->postJson('/api/integrations/sync-conflicts/'.SyncConflict::sole()->id.'/resolve', ['resolution' => 'keep_external'])->assertNotFound();
        $this->assertSame('open', SyncConflict::sole()->status);
    }

    public function test_nothing_secret_is_part_of_what_is_shown(): void
    {
        $this->conflicting();
        $body = (string) $this->getJson('/api/integrations')->getContent();
        foreach (['"tok"', 'gsecret', '"r"'] as $leak) {
            $this->assertStringNotContainsString($leak, $body);
        }
    }
}
