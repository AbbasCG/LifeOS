<?php

namespace Tests\Feature;

use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CopilotContext;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Tests\TestCase;

/**
 * GET /api/prayer-times, the settings that drive it, and the privacy of the coordinates.
 */
class PrayerTimesApiTest extends TestCase
{
    use RefreshDatabase;

    /** Deliberately odd digits, so a leak into a payload or a log line is easy to grep for. */
    private const LAT = 21.422487;

    private const LNG = 39.826206;

    private function user(array $prefs = []): User
    {
        config(['ai.provider' => 'disabled']);
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => array_replace(['timezone' => 'Asia/Riyadh', 'language' => 'en'], $prefs)]);

        return $user;
    }

    /** @return array<string, mixed> */
    private function place(array $extra = []): array
    {
        return ['prayer_enabled' => true, 'prayer_lat' => self::LAT, 'prayer_lng' => self::LNG] + $extra;
    }

    // ---- the endpoint ----

    public function test_guests_cannot_read_prayer_times(): void
    {
        $this->getJson('/api/prayer-times?from=2027-02-03')->assertUnauthorized();
    }

    public function test_off_by_default_it_returns_nothing(): void
    {
        $this->actingAs($this->user());
        $this->getJson('/api/prayer-times?from=2027-02-03&days=3')->assertOk()->assertExactJson(['enabled' => false, 'days' => []]);

        // Turned on without a place can not happen through the settings, but a stored half-state still returns nothing.
        $half = $this->user(['prayer_enabled' => true]);
        $this->actingAs($half)->getJson('/api/prayer-times?from=2027-02-03')->assertOk()->assertExactJson(['enabled' => false, 'days' => []]);
    }

    public function test_the_response_has_the_documented_shape(): void
    {
        $this->actingAs($this->user($this->place(['prayer_method' => 'umm_al_qura'])));
        $r = $this->getJson('/api/prayer-times?from=2027-02-03&days=3')->assertOk()
            ->assertJsonPath('enabled', true)->assertJsonPath('timezone', 'Asia/Riyadh')->assertJsonPath('method', 'umm_al_qura')
            ->assertJsonCount(3, 'days')
            ->assertJsonStructure(['enabled', 'timezone', 'method', 'days' => ['*' => ['date', 'ramadan', 'times' => ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'], 'windows' => ['*' => ['prayer', 'starts_at', 'ends_at']], 'iftar']]]);

        $this->assertSame(['2027-02-03', '2027-02-04', '2027-02-05'], array_column($r->json('days'), 'date'));
        $day = $r->json('days.0');
        $this->assertFalse($day['ramadan']);
        $this->assertNull($day['iftar']);
        $this->assertSame(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'], array_column($day['windows'], 'prayer'));
        foreach ($day['times'] as $name => $iso) {
            $this->assertMatchesRegularExpression('/^2027-02-0[34]T\d\d:\d\d:00Z$/', $iso, $name);
        }
        $order = array_values($day['times']);
        $sorted = $order;
        sort($sorted);
        $this->assertSame($sorted, $order, 'fajr < sunrise < dhuhr < asr < maghrib < isha');
        // Makkah, 3 Feb 2027: Dhuhr about 12:20 local = 09:20 UTC, Maghrib about 18:10 local.
        $this->assertGreaterThan('2027-02-03T09:00:00Z', $day['times']['dhuhr']);
        $this->assertLessThan('2027-02-03T09:45:00Z', $day['times']['dhuhr']);
        // The windows are [time - 10, time + 20] by default.
        $dhuhr = CarbonImmutable::parse($day['times']['dhuhr']);
        $window = $day['windows'][1];
        $this->assertSame($dhuhr->subMinutes(10)->format('Y-m-d\TH:i:s\Z'), $window['starts_at']);
        $this->assertSame($dhuhr->addMinutes(20)->format('Y-m-d\TH:i:s\Z'), $window['ends_at']);
        // Friday (5 Feb) has the longer Jumu'ah window: 75 minutes after Dhuhr by default.
        $friday = collect($r->json('days.2.windows'))->firstWhere('prayer', 'dhuhr');
        $fridayDhuhr = CarbonImmutable::parse($r->json('days.2.times.dhuhr'));
        $this->assertSame($fridayDhuhr->addMinutes(75)->format('Y-m-d\TH:i:s\Z'), $friday['ends_at']);
    }

    public function test_days_are_local_dates_in_the_users_timezone_and_default_to_today(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-02-03 22:30', 'UTC')); // already 4 February in Makkah
        $this->actingAs($this->user($this->place()));
        $this->getJson('/api/prayer-times')->assertOk()->assertJsonCount(1, 'days')->assertJsonPath('days.0.date', '2027-02-04');
    }

    public function test_ramadan_and_iftar_are_reported_per_day(): void
    {
        $this->actingAs($this->user($this->place(['ramadan_mode' => 'auto', 'iftar_minutes' => 30])));
        $r = $this->getJson('/api/prayer-times?from=2027-02-07&days=3')->assertOk();
        $this->assertSame([false, true, true], array_column($r->json('days'), 'ramadan'));
        $this->assertNull($r->json('days.0.iftar'));
        $maghrib = CarbonImmutable::parse($r->json('days.1.times.maghrib'));
        $this->assertSame(['starts_at' => $maghrib->format('Y-m-d\TH:i:s\Z'), 'ends_at' => $maghrib->addMinutes(30)->format('Y-m-d\TH:i:s\Z')], $r->json('days.1.iftar'));

        $off = $this->user($this->place(['ramadan_mode' => 'off']));
        $this->actingAs($off)->getJson('/api/prayer-times?from=2027-02-09')->assertOk()->assertJsonPath('days.0.ramadan', false)->assertJsonPath('days.0.iftar', null);
    }

    public function test_a_day_without_a_sunrise_has_empty_times_and_no_windows(): void
    {
        $this->actingAs($this->user(['timezone' => 'Europe/Oslo', 'prayer_enabled' => true, 'prayer_lat' => 70.0, 'prayer_lng' => 25.0]));
        $this->getJson('/api/prayer-times?from=2027-06-21')->assertOk()->assertJsonPath('days.0.times.fajr', null)->assertJsonPath('days.0.windows', [])->assertJsonPath('days.0.iftar', null);
    }

    public function test_query_limits(): void
    {
        $this->actingAs($this->user($this->place()));
        $this->getJson('/api/prayer-times?from=2027-02-03&days=42')->assertOk()->assertJsonCount(42, 'days');
        $this->getJson('/api/prayer-times?from=2027-02-03&days=43')->assertUnprocessable();
        $this->getJson('/api/prayer-times?from=2027-02-03&days=0')->assertUnprocessable();
        $this->getJson('/api/prayer-times?from=03-02-2027')->assertUnprocessable();
    }

    public function test_another_accounts_place_never_leaks(): void
    {
        $owner = $this->user($this->place(['prayer_method' => 'egyptian']));
        $other = $this->user();

        $this->actingAs($other);
        $this->getJson('/api/prayer-times?from=2027-02-03')->assertOk()->assertExactJson(['enabled' => false, 'days' => []]);
        $settings = $this->getJson('/api/settings')->assertOk()->assertJsonPath('prayer_enabled', false)->assertJsonPath('prayer_lat', null)->assertJsonPath('prayer_lng', null)->assertJsonPath('prayer_method', 'umm_al_qura');
        $this->assertStringNotContainsString((string) self::LAT, $settings->getContent());

        // The owner's own response never contains their coordinates either: times are all it needs to say.
        $mine = $this->actingAs($owner)->getJson('/api/prayer-times?from=2027-02-03&days=2')->assertOk();
        $this->assertStringNotContainsString('21.42', $mine->getContent());
        $this->assertStringNotContainsString('39.82', $mine->getContent());
        $this->assertSame('egyptian', $mine->json('method'));
    }

    // ---- settings ----

    public function test_the_settings_return_the_defaults_and_store_the_new_values(): void
    {
        $this->actingAs($this->user());
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('prayer_enabled', false)->assertJsonPath('prayer_lat', null)->assertJsonPath('prayer_lng', null)
            ->assertJsonPath('prayer_method', 'umm_al_qura')->assertJsonPath('prayer_asr', 'standard')->assertJsonPath('prayer_before', 10)->assertJsonPath('prayer_after', 20)
            ->assertJsonPath('jumuah_after', 75)->assertJsonPath('ramadan_mode', 'off')->assertJsonPath('ramadan_work_start', '10:00')->assertJsonPath('ramadan_work_end', '15:00')
            ->assertJsonPath('iftar_minutes', 45);

        $saved = $this->putJson('/api/settings', ['prayer_lat' => '21.422487', 'prayer_lng' => 39.826206, 'prayer_enabled' => true, 'prayer_method' => 'turkey', 'prayer_asr' => 'hanafi', 'prayer_before' => 5, 'prayer_after' => 30,
            'jumuah_after' => 90, 'ramadan_mode' => 'auto', 'ramadan_work_start' => '09:30', 'ramadan_work_end' => '14:30', 'iftar_minutes' => 60])->assertOk();
        $saved->assertJsonPath('prayer_enabled', true)->assertJsonPath('prayer_method', 'turkey')->assertJsonPath('prayer_asr', 'hanafi')->assertJsonPath('ramadan_mode', 'auto')->assertJsonPath('iftar_minutes', 60);
        $this->assertSame(self::LAT, $saved->json('prayer_lat'), 'numeric strings are stored as numbers');
        $this->assertSame(self::LNG, $saved->json('prayer_lng'));
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('prayer_before', 5)->assertJsonPath('prayer_after', 30)->assertJsonPath('jumuah_after', 90)->assertJsonPath('ramadan_work_start', '09:30');
    }

    public function test_prayer_enabled_needs_both_coordinates(): void
    {
        $this->actingAs($this->user());
        $this->putJson('/api/settings', ['prayer_enabled' => true])->assertUnprocessable()->assertJsonValidationErrors('prayer_enabled');
        $this->putJson('/api/settings', ['prayer_enabled' => true, 'prayer_lat' => 21.4])->assertUnprocessable()->assertJsonValidationErrors('prayer_enabled');
        $this->putJson('/api/settings', ['prayer_enabled' => true, 'prayer_lng' => 39.8])->assertUnprocessable()->assertJsonValidationErrors('prayer_enabled');
        $this->getJson('/api/settings')->assertJsonPath('prayer_enabled', false)->assertJsonPath('prayer_lat', null);

        // Coordinates alone are fine (prayer stays off), and with both the switch works.
        $this->putJson('/api/settings', ['prayer_lat' => 21.4, 'prayer_lng' => 39.8])->assertOk()->assertJsonPath('prayer_enabled', false);
        $this->putJson('/api/settings', ['prayer_enabled' => true])->assertOk()->assertJsonPath('prayer_enabled', true);
        // The place cannot be removed while prayer times are on.
        $this->putJson('/api/settings', ['prayer_lat' => null])->assertUnprocessable()->assertJsonValidationErrors('prayer_enabled');
        $this->putJson('/api/settings', ['prayer_enabled' => false, 'prayer_lat' => null, 'prayer_lng' => null])->assertOk()->assertJsonPath('prayer_lat', null);
    }

    public function test_every_prayer_setting_is_range_checked(): void
    {
        $this->actingAs($this->user());
        $bad = [
            'prayer_lat' => [-90.5, 91, 'north'], 'prayer_lng' => [-180.5, 181, 'east'], 'prayer_method' => ['mwl', 'moonsighting', 5], 'prayer_asr' => ['maliki', 1],
            'prayer_before' => [-1, 61, 'ten'], 'prayer_after' => [-1, 91], 'jumuah_after' => [29, 181], 'ramadan_mode' => ['yes', 'auto2'], 'ramadan_work_start' => ['10', '25:00'],
            'ramadan_work_end' => ['3pm'], 'iftar_minutes' => [14, 121], 'prayer_enabled' => ['maybe'],
        ];
        foreach ($bad as $key => $values) {
            foreach ($values as $value) {
                $this->putJson('/api/settings', [$key => $value])->assertUnprocessable()->assertJsonValidationErrors($key);
            }
        }
        // The limits themselves are accepted.
        $this->putJson('/api/settings', ['prayer_lat' => -90, 'prayer_lng' => 180, 'prayer_before' => 0, 'prayer_after' => 90, 'jumuah_after' => 30, 'iftar_minutes' => 15])->assertOk();
        $this->putJson('/api/settings', ['prayer_lat' => 90, 'prayer_lng' => -180, 'prayer_before' => 60, 'prayer_after' => 0, 'jumuah_after' => 180, 'iftar_minutes' => 120])->assertOk();
        foreach (['umm_al_qura', 'muslim_world_league', 'egyptian', 'karachi', 'north_america', 'kuwait', 'qatar', 'turkey'] as $method) {
            $this->putJson('/api/settings', ['prayer_method' => $method])->assertOk()->assertJsonPath('prayer_method', $method);
        }
        foreach (['off', 'auto', 'on'] as $mode) {
            $this->putJson('/api/settings', ['ramadan_mode' => $mode])->assertOk()->assertJsonPath('ramadan_mode', $mode);
        }
    }

    public function test_ramadan_work_hours_must_end_after_they_start(): void
    {
        $this->actingAs($this->user());
        $this->putJson('/api/settings', ['ramadan_work_start' => '15:00', 'ramadan_work_end' => '15:00'])->assertUnprocessable()->assertJsonValidationErrors('ramadan_work_end');
        $this->putJson('/api/settings', ['ramadan_work_end' => '09:00'])->assertUnprocessable()->assertJsonValidationErrors('ramadan_work_end');
        $this->putJson('/api/settings', ['ramadan_work_start' => '08:00', 'ramadan_work_end' => '13:00'])->assertOk();
    }

    public function test_existing_settings_are_untouched_by_the_new_keys(): void
    {
        $user = $this->user(['work_start' => '08:00', 'work_end' => '16:00', 'week_start' => 6]);
        $this->actingAs($user)->putJson('/api/settings', ['prayer_method' => 'karachi'])->assertOk()->assertJsonPath('work_start', '08:00')->assertJsonPath('week_start', 6);
        $this->assertSame('08:00', $user->preferences()['work_start']);
    }

    // ---- privacy ----

    public function test_the_coordinates_never_reach_the_ai_context(): void
    {
        $user = $this->user($this->place(['ramadan_mode' => 'on', 'ai_connected_data' => true]));
        Task::create(['user_id' => $user->id, 'title' => 'Plan the week', 'estimated_minutes' => 60, 'due_at' => '2027-02-04T12:00:00Z']);
        $this->travelTo(CarbonImmutable::parse('2027-02-03 07:00', 'UTC'));

        // A message that makes every section of the context relevant.
        $message = 'Plan my week and today: schedule time for focus, goals, habits, projects, workload and deadlines, what is my progress and the best time to pray?';
        $context = app(CopilotContext::class)->build($user, $message);
        $json = json_encode($context, JSON_THROW_ON_ERROR);
        $this->assertGreaterThan(3, count($context['sources']), 'several sections were built');
        foreach (['21.42', '39.82', 'prayer_', 'lat', 'lng', 'latitude', 'longitude', 'coordinates'] as $needle) {
            $this->assertStringNotContainsString($needle, $json, "the AI context must not contain {$needle}");
        }

        // And the real request to a provider, from the Assistant and from Copilot.
        config(['ai.provider' => 'openai', 'ai.providers.openai.key' => 'test-key']);
        Http::fake(['api.openai.com/*' => Http::response(['choices' => [['message' => ['content' => json_encode(['message' => 'Here is a plan.', 'intent' => 'answer', 'schedule' => null, 'subtasks' => [], 'query' => null, 'review' => null])]]]])]);
        $this->actingAs($user);
        $this->postJson('/api/assistant', ['message' => $message, 'language' => 'en'])->assertOk();
        $this->postJson('/api/copilot/messages', ['message' => $message, 'language' => 'en']);
        $sent = Http::recorded();
        $this->assertNotEmpty($sent, 'a provider request was made');
        foreach ($sent as [$request]) {
            /** @var HttpRequest $request */
            $body = $request->body().json_encode($request->data()).$request->url();
            foreach (['21.42', '39.82', 'prayer_lat', 'prayer_lng', 'prayer_enabled'] as $needle) {
                $this->assertStringNotContainsString($needle, $body, "the provider request must not contain {$needle}");
            }
        }
    }

    public function test_saving_and_reading_prayer_settings_writes_no_coordinates_to_the_logs(): void
    {
        $logged = [];
        Log::listen(function ($event) use (&$logged) {
            $logged[] = $event->message.json_encode($event->context);
        });
        $this->actingAs($this->user());
        $this->putJson('/api/settings', ['prayer_lat' => self::LAT, 'prayer_lng' => self::LNG, 'prayer_enabled' => true])->assertOk();
        $this->getJson('/api/prayer-times?from=2027-02-03&days=2')->assertOk();
        $this->putJson('/api/settings', ['prayer_lat' => 999])->assertUnprocessable();

        foreach ($logged as $line) {
            $this->assertStringNotContainsString('21.42', $line);
            $this->assertStringNotContainsString('39.82', $line);
        }
    }
}
