<?php

namespace Tests\Feature;

use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\PlanningService;
use App\Services\PrayerTimes;
use App\Services\Ramadan;
use Carbon\CarbonImmutable;
use DateTime;
use DateTimeZone;
use Illuminate\Foundation\Testing\RefreshDatabase;
use IntlCalendar;
use Tests\TestCase;

/**
 * Ramadan mode: off by default, 'on' always, 'auto' while the Umm al-Qura Hijri month is 9 (moved by the user's hijri_offset).
 * The dates are computed from IntlCalendar, not typed in, so the test follows whatever the calendar data says.
 */
class RamadanModeTest extends TestCase
{
    use RefreshDatabase;

    /** First day of Ramadan 1448 (the Gregorian date on which IntlCalendar's Umm al-Qura calendar reaches month 9). */
    private static function firstDay(): CarbonImmutable
    {
        for ($day = CarbonImmutable::parse('2027-01-20'); $day < CarbonImmutable::parse('2027-03-01'); $day = $day->addDay()) {
            [$month, $dom] = self::hijri($day);
            if ($month === 9 && $dom === 1) {
                return $day;
            }
        }
        self::fail('Ramadan 1448 not found');
    }

    /** Last day of Ramadan 1448. */
    private static function lastDay(): CarbonImmutable
    {
        $day = self::firstDay();
        while (self::hijri($day->addDay())[0] === 9) {
            $day = $day->addDay();
        }

        return $day;
    }

    /** @return array{0: int, 1: int} Hijri month (1-12) and day of month of a Gregorian date. */
    private static function hijri(CarbonImmutable $day): array
    {
        $calendar = IntlCalendar::fromDateTime(new DateTime($day->toDateString().' 12:00:00', new DateTimeZone('UTC')), 'en@calendar=islamic-umalqura');

        return [$calendar->get(IntlCalendar::FIELD_MONTH) + 1, $calendar->get(IntlCalendar::FIELD_DAY_OF_MONTH)];
    }

    /** The first date in [from, ...) that falls on the given weekday (Carbon numbers: 1 = Monday ... 0 = Sunday). */
    private static function weekday(CarbonImmutable $from, int $dayOfWeek): CarbonImmutable
    {
        while ($from->dayOfWeek !== $dayOfWeek) {
            $from = $from->addDay();
        }

        return $from;
    }

    private function user(array $prefs = []): User
    {
        config(['ai.provider' => 'disabled']);
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => array_replace(['timezone' => 'UTC', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'buffer_minutes' => 10], $prefs)]);

        return $user;
    }

    public function test_the_calendar_anchor_is_what_the_test_expects(): void
    {
        $this->assertSame('2027-02-08', self::firstDay()->toDateString(), 'Ramadan 1448 starts on 8 February 2027 in the Umm al-Qura calendar');
        $this->assertSame('2027-03-08', self::lastDay()->toDateString());
    }

    public function test_off_is_the_default_and_never_active(): void
    {
        $user = $this->user();
        $this->assertFalse(Ramadan::active($user, self::firstDay()->toDateString()));
        $this->assertSame('off', $this->actingAs($user)->getJson('/api/settings')->json('ramadan_mode'));
        $this->assertFalse(Ramadan::active($this->user(['ramadan_mode' => 'off']), self::firstDay()->addDays(3)->toDateString()));
        $this->assertFalse(Ramadan::active($this->user(['ramadan_mode' => 'whatever']), self::firstDay()->toDateString()), 'an unknown mode is off');
    }

    public function test_on_is_always_active(): void
    {
        $user = $this->user(['ramadan_mode' => 'on']);
        $this->assertTrue(Ramadan::active($user, '2027-06-01'));
        $this->assertTrue(Ramadan::active($user, self::firstDay()->toDateString()));
    }

    public function test_auto_follows_the_hijri_month_and_the_users_offset(): void
    {
        $first = self::firstDay();
        $last = self::lastDay();
        $auto = $this->user(['ramadan_mode' => 'auto']);

        $this->assertFalse(Ramadan::active($auto, $first->subDay()->toDateString()));
        $this->assertTrue(Ramadan::active($auto, $first->toDateString()));
        $this->assertTrue(Ramadan::active($auto, $first->addDays(14)->toDateString()));
        $this->assertTrue(Ramadan::active($auto, $last->toDateString()));
        $this->assertFalse(Ramadan::active($auto, $last->addDay()->toDateString()));
        $this->assertFalse(Ramadan::active($auto, '2027-06-01'));

        // hijri_offset moves the Hijri date by that many days, as the Hijri dates in the app do: +1 starts Ramadan a day earlier.
        $ahead = $this->user(['ramadan_mode' => 'auto', 'hijri_offset' => 1]);
        $this->assertTrue(Ramadan::active($ahead, $first->subDay()->toDateString()));
        $this->assertFalse(Ramadan::active($ahead, $first->subDays(2)->toDateString()));
        $this->assertFalse(Ramadan::active($ahead, $last->toDateString()), 'and ends a day earlier');
        $behind = $this->user(['ramadan_mode' => 'auto', 'hijri_offset' => -1]);
        $this->assertFalse(Ramadan::active($behind, $first->toDateString()));
        $this->assertTrue(Ramadan::active($behind, $first->addDay()->toDateString()));
        $this->assertTrue(Ramadan::active($behind, $last->addDay()->toDateString()));
        $this->assertFalse(Ramadan::active($behind, $last->addDays(2)->toDateString()));
    }

    public function test_the_work_window_changes_only_on_work_days_of_ramadan(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $user = $this->user(['ramadan_mode' => 'auto']);
        $planning = app(PlanningService::class);
        $c = $planning->config($user);
        $wednesday = self::weekday(self::firstDay(), 3);
        $saturday = self::weekday(self::firstDay(), 6);

        $window = fn (CarbonImmutable $day) => array_map(fn ($t) => $t->format('H:i'), $planning->windows($c, $day)['work'] ?? []);
        $this->assertSame(['10:00', '15:00'], $window($wednesday));
        $this->assertSame([], $window($saturday), 'not a work day, so no work window, Ramadan or not');
        $this->assertSame(['09:00', '17:00'], $window(CarbonImmutable::parse('2027-02-03', 'UTC')), 'a work day before Ramadan is unchanged');
        $this->assertSame(['09:00', '17:00'], $window(self::lastDay()->addDays(3)->next(CarbonImmutable::WEDNESDAY)), 'and after it');

        // Off: the same Wednesday keeps the normal hours.
        $off = $planning->config($this->user(['ramadan_mode' => 'off']));
        $this->assertSame(['09:00', '17:00'], array_map(fn ($t) => $t->format('H:i'), $planning->windows($off, $wednesday)['work']));
        // The user's own Ramadan hours are used.
        $custom = $planning->config($this->user(['ramadan_mode' => 'on', 'ramadan_work_start' => '08:30', 'ramadan_work_end' => '14:00']));
        $this->assertSame(['08:30', '14:00'], array_map(fn ($t) => $t->format('H:i'), $planning->windows($custom, $wednesday)['work']));
    }

    public function test_the_daily_limit_is_explicit_when_set_and_75_percent_of_the_usual_when_not(): void
    {
        $planning = app(PlanningService::class);
        $wednesday = self::weekday(self::firstDay(), 3);
        $normal = CarbonImmutable::parse('2027-02-03', 'UTC');
        $hours = ['work_start' => '08:00', 'work_end' => '18:00', 'ramadan_mode' => 'auto', 'ramadan_work_start' => '09:00', 'ramadan_work_end' => '17:00'];

        $c = $planning->config($this->user($hours));
        $ramadanWindow = $planning->windows($c, $wednesday)['work'];
        $normalWindow = $planning->windows($c, $normal)['work'];
        $this->assertSame(510, $planning->areaLimit($c, 'work', $normalWindow), '85% of 10 hours');
        $this->assertSame((int) floor(510 * 0.75), $planning->areaLimit($c, 'work', $ramadanWindow), '75% of the usual limit');
        $this->assertSame(382, $planning->areaLimit($c, 'work', $ramadanWindow));

        $explicit = $planning->config($this->user($hours + ['daily_focus_limit' => 200]));
        $this->assertSame(200, $planning->areaLimit($explicit, 'work', $ramadanWindow), 'an explicit limit is respected as it is');
        $this->assertSame(200, $planning->areaLimit($explicit, 'work', $normalWindow));

        // Never more than the Ramadan window itself.
        $short = $planning->config($this->user(['ramadan_mode' => 'auto', 'ramadan_work_start' => '10:00', 'ramadan_work_end' => '12:00']));
        $this->assertSame(120, $planning->areaLimit($short, 'work', $planning->windows($short, $wednesday)['work']));
    }

    public function test_the_week_planner_places_blocks_inside_the_ramadan_hours_only(): void
    {
        $wednesday = self::weekday(self::firstDay(), 3);
        $this->travelTo($wednesday->subDay()->setTime(8, 0));
        $user = $this->user(['ramadan_mode' => 'auto']);
        Task::create(['user_id' => $user->id, 'title' => 'Write', 'estimated_minutes' => 120, 'priority' => 'high']);
        Task::create(['user_id' => $user->id, 'title' => 'Read', 'estimated_minutes' => 90]);

        $plan = $this->actingAs($user)->postJson('/api/plans', ['date' => $wednesday->toDateString(), 'days' => 1])->assertCreated()->json();

        $this->assertNotEmpty($plan['items']);
        foreach ($plan['items'] as $item) {
            $this->assertGreaterThanOrEqual('10:00', CarbonImmutable::parse($item['starts_at'])->format('H:i'));
            $this->assertLessThanOrEqual('15:00', CarbonImmutable::parse($item['ends_at'])->format('H:i'));
        }
        $this->assertSame(300, $plan['summary']['days'][0]['capacity_minutes']);

        // The same weekday outside Ramadan is planned in the normal 09:00-17:00 hours.
        $this->travelTo(CarbonImmutable::parse('2027-04-13 08:00', 'UTC'));
        $plain = $this->postJson('/api/plans', ['date' => '2027-04-14', 'days' => 1])->assertCreated()->json();
        $this->assertSame(480, $plain['summary']['days'][0]['capacity_minutes']);
        $this->assertSame('09:00', CarbonImmutable::parse($plain['items'][0]['starts_at'])->format('H:i'));
    }

    public function test_availability_briefing_and_day_plan_use_the_ramadan_hours(): void
    {
        $wednesday = self::weekday(self::firstDay(), 3);
        $this->travelTo($wednesday->setTime(6, 0));
        $user = $this->user(['ramadan_mode' => 'auto']);
        $this->actingAs($user);

        $day = $this->getJson('/api/availability?date='.$wednesday->toDateString())->assertOk()->json('days.0');
        $this->assertSame(['10:00', '15:00'], [$day['work_start'], $day['work_end']]);
        $this->assertSame(300, $day['free_minutes']);
        $this->assertSame('10:00', CarbonImmutable::parse($day['slots'][0]['starts_at'])->format('H:i'));

        $this->getJson('/api/briefing')->assertOk()->assertJsonPath('stats.available_minutes', 300);
        $this->getJson('/api/day-plan?date='.$wednesday->toDateString())->assertOk()->assertJsonPath('budget.window_minutes', 300);

        // Off: the same day offers the whole 09:00-17:00.
        UserSetting::where('user_id', $user->id)->update(['preferences' => array_replace($user->preferences(), ['ramadan_mode' => 'off'])]);
        $this->getJson('/api/availability?date='.$wednesday->toDateString())->assertOk()->assertJsonPath('days.0.free_minutes', 480);
        $this->getJson('/api/briefing')->assertOk()->assertJsonPath('stats.available_minutes', 480);
    }

    public function test_the_suggestion_after_a_conflict_starts_in_the_ramadan_hours(): void
    {
        $wednesday = self::weekday(self::firstDay(), 3);
        $this->travelTo($wednesday->subDay()->setTime(8, 0));
        $user = $this->user(['ramadan_mode' => 'auto']);
        $this->actingAs($user);
        $day = $wednesday->toDateString();
        $this->postJson('/api/events', ['title' => 'Early call', 'kind' => 'fixed', 'starts_at' => "{$day}T07:00:00Z", 'ends_at' => "{$day}T08:00:00Z"])->assertCreated();

        $conflict = $this->postJson('/api/events', ['title' => 'Same slot', 'kind' => 'fixed', 'starts_at' => "{$day}T07:00:00Z", 'ends_at' => "{$day}T07:30:00Z"])->assertUnprocessable()->json('conflict');
        $this->assertSame("{$day}T10:00:00Z", $conflict['suggestion']['starts_at'], 'the first free time in Ramadan hours, not 09:00');

        UserSetting::where('user_id', $user->id)->update(['preferences' => array_replace($user->preferences(), ['ramadan_mode' => 'off'])]);
        $conflict = $this->postJson('/api/events', ['title' => 'Same slot', 'kind' => 'fixed', 'starts_at' => "{$day}T07:00:00Z", 'ends_at' => "{$day}T07:30:00Z"])->assertUnprocessable()->json('conflict');
        $this->assertSame("{$day}T09:00:00Z", $conflict['suggestion']['starts_at']);
    }

    public function test_the_iftar_window_is_protected_like_a_prayer_window_when_prayer_times_are_on(): void
    {
        $wednesday = self::weekday(self::firstDay(), 3);
        $this->travelTo($wednesday->subDay()->setTime(8, 0));
        $place = ['timezone' => 'Asia/Riyadh', 'prayer_enabled' => true, 'prayer_lat' => 21.4225, 'prayer_lng' => 39.8262, 'iftar_minutes' => 45, 'personal_start' => '17:00', 'personal_end' => '21:00'];
        $planning = app(PlanningService::class);

        $on = $this->user($place + ['ramadan_mode' => 'auto']);
        $c = $planning->config($on);
        $date = $wednesday->toDateString();
        $maghrib = PrayerTimes::for($on)->times($date)['maghrib'];
        $evening = $planning->windows($c, CarbonImmutable::parse($date, 'Asia/Riyadh'))['personal'];

        $iftar = PrayerTimes::for($on)->iftar($date);
        $this->assertSame(45 * 60, $iftar['ends_at']->getTimestamp() - $iftar['starts_at']->getTimestamp());
        $this->assertEquals($maghrib, $iftar['starts_at']);

        $free = $planning->freeIntervals($evening[0]->utc(), $evening[1]->utc(), [], 0, $c);
        foreach ($free as [$s, $e]) {
            $this->assertFalse($s < $maghrib->addMinutes(45) && $e > $maghrib, 'no free time between Maghrib and the end of iftar');
        }
        // The prayer window alone would end 20 minutes after Maghrib; the iftar window keeps it clear for 45.
        $this->assertTrue(collect($free)->contains(fn (array $f) => $f[0]->equalTo($maghrib->addMinutes(45))), 'free time resumes right after iftar');

        // Prayer times off: iftar is not protected (it hangs off Maghrib, which needs the coordinates).
        $noPrayer = $this->user(['timezone' => 'Asia/Riyadh', 'ramadan_mode' => 'auto', 'personal_start' => '17:00', 'personal_end' => '21:00']);
        $c = $planning->config($noPrayer);
        $this->assertCount(1, $planning->freeIntervals($evening[0]->utc(), $evening[1]->utc(), [], 0, $c));

        // Ramadan mode off: the prayer windows stay, the iftar extension is gone.
        $prayerOnly = $this->user($place + ['ramadan_mode' => 'off']);
        $this->assertNull(PrayerTimes::for($prayerOnly)->iftar($date));
        $this->assertNotEmpty(PrayerTimes::for($prayerOnly)->windows($date));
    }
}
