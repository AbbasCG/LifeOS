<?php

namespace Tests\Feature;

use App\Integrations\Calendar\HostResolver;
use App\Integrations\Calendar\WindowsZones;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\ExternalEvent;
use App\Models\SyncRun;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class CalendarFeedsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    /** @var array<string, list<string>> */
    private array $dns = ['calendar.example.org' => ['93.184.216.34']];

    protected function setUp(): void
    {
        parent::setUp();
        // Monday 22 March 2027, 07:00 UTC; Europe switches to summer time on Sunday 28 March.
        $this->travelTo(CarbonImmutable::parse('2027-03-22 07:00:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->actingAs($this->user);
        $dns = &$this->dns;
        $this->app->instance(HostResolver::class, new class($dns) extends HostResolver
        {
            /** @param array<string, list<string>> $dns */
            public function __construct(private array &$dns) {}

            public function resolve(string $host): array
            {
                return $this->dns[$host] ?? [];
            }
        });
    }

    private function feed(string ...$events): string
    {
        return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nX-WR-CALNAME:Rotterdam\\, School\r\nX-WR-TIMEZONE:Europe/Amsterdam\r\n"
            .implode('', array_map(fn ($e) => "BEGIN:VEVENT\r\n".trim($e)."\r\nEND:VEVENT\r\n", $events))."END:VCALENDAR\r\n";
    }

    private function school(): string
    {
        return $this->feed(
            // Weekly class on Monday and Wednesday at 09:00 Amsterdam, six times, across the DST change.
            "UID:class-1\r\nSUMMARY:Maths\r\nDTSTART;TZID=Europe/Amsterdam:20270322T090000\r\nDTEND;TZID=Europe/Amsterdam:20270322T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r\nEXDATE;TZID=Europe/Amsterdam:20270324T090000",
            // One occurrence moved to 11:00.
            "UID:class-1\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20270329T090000\r\nSUMMARY:Maths (room change)\r\nDTSTART;TZID=Europe/Amsterdam:20270329T110000\r\nDTEND;TZID=Europe/Amsterdam:20270329T120000",
            "UID:holiday\r\nSUMMARY:Easter Monday\r\nDTSTART;VALUE=DATE:20270329\r\nDTEND;VALUE=DATE:20270330",
            "UID:cancelled\r\nSUMMARY:Cancelled trip\r\nSTATUS:CANCELLED\r\nDTSTART:20270323T120000Z\r\nDTEND:20270323T130000Z",
            "UID:free\r\nSUMMARY:Optional reading\r\nTRANSP:TRANSPARENT\r\nDTSTART:20270323T140000Z\r\nDURATION:PT1H",
            // Folded long line, Windows TZID and a DURATION.
            "UID:parents\r\nSUMMARY:Parents' evening with the \r\n mentor\r\nDTSTART;TZID=\"W. Europe Standard Time\":20270325T190000\r\nDURATION:PT1H30M",
            "UID:floating\r\nSUMMARY:Sports day\r\nDTSTART:20270326T130000\r\nDTEND:20270326T160000",
            // Second Tuesday of every month: not expanded rather than guessed.
            "UID:council\r\nSUMMARY:Council\r\nDTSTART:20270309T180000Z\r\nDTEND:20270309T190000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU",
        );
    }

    public function test_subscribing_to_a_feed_imports_recurring_events_with_exceptions_and_hides_the_address(): void
    {
        Http::fake(['calendar.example.org/*' => Http::response($this->school(), 200, ['Content-Type' => 'text/calendar', 'ETag' => '"v1"'])]);

        $account = $this->postJson('/api/integrations/ics', ['url' => 'webcal://calendar.example.org/school.ics?token=s3cret'])->assertCreated()
            ->assertJsonPath('account.provider', 'ics')->assertJsonPath('account.display_name', 'Rotterdam, School')->assertJsonPath('account.email', 'calendar.example.org')->json('account');
        Http::assertSent(fn (HttpRequest $r) => str_starts_with($r->url(), 'https://calendar.example.org/school.ics'));

        $local = fn (ExternalEvent $e) => $e->title.' '.$e->starts_at->setTimezone('Europe/Amsterdam')->format('D d H:i').'–'.$e->ends_at->setTimezone('Europe/Amsterdam')->format('H:i');
        $this->assertSame([
            'Maths Mon 22 09:00–10:00',
            "Parents' evening with the mentor Thu 25 19:00–20:30",
            'Sports day Fri 26 13:00–16:00',
            'Easter Monday Mon 29 00:00–00:00',
            'Maths (room change) Mon 29 11:00–12:00',
            'Maths Wed 31 09:00–10:00',
            'Maths Mon 05 09:00–10:00',
            'Maths Wed 07 09:00–10:00',
        ], ExternalEvent::orderBy('starts_at')->get()->map($local)->all());
        $this->assertTrue(ExternalEvent::where('title', 'Easter Monday')->value('all_day'));
        $this->assertSame('Europe/Berlin', ExternalEvent::where('title', 'like', 'Parents%')->value('timezone'));
        $this->assertSame(1, ExternalEvent::where('title', 'Maths')->distinct()->count('series_id'));
        $this->assertSame(1, SyncRun::sole()->details['skipped'], 'the unsupported monthly rule is reported, not guessed');

        $hub = $this->getJson('/api/integrations')->assertOk();
        $this->assertStringNotContainsString('s3cret', $hub->getContent());
        $this->assertStringNotContainsString('school.ics', $hub->getContent());
        $this->assertSame('url', collect($hub->json('providers'))->firstWhere('provider', 'ics')['connect_mode']);
        $this->assertStringNotContainsString('s3cret', json_encode(AuditLog::pluck('meta')->all()));
        $this->assertSame('https://calendar.example.org/school.ics?token=s3cret', CalendarAccount::find($account['id'])->access_token);
        $this->assertStringNotContainsString('s3cret', (string) CalendarAccount::whereKey($account['id'])->toBase()->value('access_token'), 'stored encrypted');

        $this->postJson('/api/integrations/ics', ['url' => 'https://calendar.example.org/school.ics?token=s3cret'])->assertUnprocessable()->assertJsonValidationErrors('url');
    }

    public function test_unchanged_feeds_cost_one_conditional_request_and_changes_replace_the_window(): void
    {
        $round = 0;
        Http::fake(['calendar.example.org/*' => function (HttpRequest $r) use (&$round) {
            return match ($round) {
                0 => Http::response($this->school(), 200, ['ETag' => '"v1"']),
                1 => Http::response('', 304, ['ETag' => '"v1"']),
                default => Http::response($this->feed("UID:new\r\nSUMMARY:Exam\r\nDTSTART:20270323T080000Z\r\nDTEND:20270323T100000Z"), 200, ['ETag' => '"v2"']),
            };
        }]);
        $id = $this->postJson('/api/integrations/ics', ['url' => 'https://calendar.example.org/school.ics'])->assertCreated()->json('account.id');
        $this->assertSame(8, ExternalEvent::count());

        $round = 1;
        $this->postJson("/api/integrations/accounts/{$id}/sync")->assertOk()->assertJsonPath('run.mode', 'incremental')->assertJsonPath('run.upserted', 0);
        Http::assertSent(fn (HttpRequest $r) => $r->header('If-None-Match') === ['"v1"']);
        $this->assertSame(8, ExternalEvent::count());

        $round = 2;
        $this->postJson("/api/integrations/accounts/{$id}/sync")->assertOk()->assertJsonPath('run.mode', 'full');
        $this->assertSame(['Exam'], ExternalEvent::pluck('title')->all());
    }

    public function test_feed_addresses_cannot_reach_private_networks(): void
    {
        // Subscribing is rate-limited like sign-in; this test is about address validation.
        $this->withoutMiddleware(ThrottleRequests::class);
        Http::fake(['*' => Http::response('', 302, ['Location' => 'https://intranet.example.org/feed.ics'])]);
        $this->dns['internal.example.org'] = ['10.0.0.5'];
        $this->dns['rebind.example.org'] = ['93.184.216.34', '127.0.0.1'];
        $this->dns['intranet.example.org'] = ['192.168.1.20'];
        $this->dns['metadata.example.org'] = ['169.254.169.254'];
        $this->dns['cgnat.example.org'] = ['100.64.0.1'];
        $this->dns['v6.example.org'] = ['fd00::1'];

        foreach ([
            'http://calendar.example.org/feed.ics' => 'https://',
            'ftp://calendar.example.org/feed.ics' => 'https://',
            'https://user:pw@calendar.example.org/feed.ics' => 'username',
            'https://calendar.example.org:8443/feed.ics' => 'custom port',
            'https://127.0.0.1/feed.ics' => 'private network',
            'https://[::1]/feed.ics' => 'private network',
            'https://internal.example.org/feed.ics' => 'private network',
            'https://rebind.example.org/feed.ics' => 'private network',
            'https://metadata.example.org/feed.ics' => 'private network',
            'https://cgnat.example.org/feed.ics' => 'private network',
            'https://v6.example.org/feed.ics' => 'private network',
            'https://nowhere.example.org/feed.ics' => 'could not be found',
        ] as $url => $message) {
            $this->postJson('/api/integrations/ics', ['url' => $url])->assertUnprocessable()->assertJsonPath('errors.url.0', fn ($m) => str_contains($m, $message));
        }
        Http::assertNothingSent();

        // A public address that redirects into the private network is refused at the redirect.
        $this->postJson('/api/integrations/ics', ['url' => 'https://calendar.example.org/feed.ics'])->assertUnprocessable()->assertJsonPath('errors.url.0', fn ($m) => str_contains($m, 'private network'));
        Http::assertSentCount(1);
        $this->assertSame(0, CalendarAccount::count());
    }

    public function test_non_calendars_oversized_feeds_and_reset_links_are_reported(): void
    {
        $round = 0;
        Http::fake(['calendar.example.org/*' => function () use (&$round) {
            return match ($round) {
                0 => Http::response('<html>Login</html>', 200),
                1 => Http::response($this->school(), 200),
                2 => Http::response('', 404),
                default => Http::response(str_repeat('x', 5 * 1024 * 1024 + 1), 200),
            };
        }]);
        $this->postJson('/api/integrations/ics', ['url' => 'https://calendar.example.org/a.ics'])->assertUnprocessable()->assertJsonPath('errors.url.0', 'This address did not return an iCalendar (.ics) feed.');

        $round = 1;
        $id = $this->postJson('/api/integrations/ics', ['url' => 'https://calendar.example.org/a.ics'])->assertCreated()->json('account.id');
        $round = 2;
        $this->postJson("/api/integrations/accounts/{$id}/sync")->assertOk()->assertJsonPath('account.status', 'revoked');
        $this->assertStringContainsString('paste the current link', CalendarAccount::find($id)->last_error);
        $this->assertSame(8, ExternalEvent::count(), 'imported events are kept until the user decides');

        $round = 3;
        $this->postJson('/api/integrations/ics', ['url' => 'https://calendar.example.org/b.ics'])->assertUnprocessable()->assertJsonPath('errors.url.0', 'The calendar feed is larger than 5 MB.');

        $this->deleteJson("/api/integrations/accounts/{$id}")->assertOk();
        $this->assertSame(0, ExternalEvent::count());
    }

    public function test_outlook_windows_timezones_become_iana_and_feed_timezone_conflicts(): void
    {
        $this->assertSame('Europe/Berlin', WindowsZones::toIana('W. Europe Standard Time'));
        $this->assertSame('America/New_York', WindowsZones::toIana('Eastern Standard Time'));
        $this->assertSame('Asia/Kolkata', WindowsZones::toIana('India Standard Time'));
        $this->assertSame('UTC', WindowsZones::toIana('UTC'));
        $this->assertSame('Europe/Amsterdam', WindowsZones::toIana('Europe/Amsterdam'));
        $this->assertNull(WindowsZones::toIana('Customized Time Zone'));
        $this->assertNull(WindowsZones::toIana(null));

        config(['services.microsoft_calendar' => ['client_id' => 'mid', 'client_secret' => 'msecret', 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/outlook/callback']]);
        Http::fake([
            'graph.microsoft.com/v1.0/me/calendars?*' => Http::response(['value' => [['id' => 'cal', 'name' => 'Calendar', 'isDefaultCalendar' => true]]]),
            'graph.microsoft.com/v1.0/me/calendars/cal/calendarView/delta*' => Http::response(['value' => [
                ['id' => 'ny', 'subject' => 'NY review', 'start' => ['dateTime' => '2027-03-23T14:00:00.0000000'], 'end' => ['dateTime' => '2027-03-23T15:00:00.0000000'], 'originalStartTimeZone' => 'Eastern Standard Time'],
                ['id' => 'odd', 'subject' => 'Custom zone', 'start' => ['dateTime' => '2027-03-23T16:00:00.0000000'], 'end' => ['dateTime' => '2027-03-23T16:30:00.0000000'], 'originalStartTimeZone' => 'Customized Time Zone'],
            ], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/me/calendars/cal/calendarView/delta?$deltatoken=d1']),
        ]);
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'outlook', 'external_account_id' => 'o', 'email' => 'me@work.com', 'access_token' => 'a', 'refresh_token' => 'r', 'token_expires_at' => now()->addHour(), 'status' => 'active',
            'collections' => [['id' => 'cal', 'name' => 'Calendar', 'color' => null, 'primary' => true, 'included' => true]]]);
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertOk();

        $this->assertSame(['America/New_York', null], ExternalEvent::orderBy('starts_at')->pluck('timezone')->all());
        $tz = collect($this->getJson('/api/timeline?from=2027-03-23')->assertOk()->json('conflicts'))->firstWhere('type', 'timezone');
        $this->assertSame(['NY review', '10:00', '15:00'], [$tz['titles'][0], $tz['organiser_time'], $tz['your_time']]);
    }
}
