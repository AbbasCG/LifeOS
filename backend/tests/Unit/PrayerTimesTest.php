<?php

namespace Tests\Unit;

use App\Services\PrayerTimes;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

/**
 * The prayer-time engine against an independent oracle: the MIT-licensed npm package `adhan` (see tests/Fixtures/README.md for how
 * tests/Fixtures/prayer-times.json was made). Tolerance is +-2 minutes per prayer: both sides round to the minute and use different
 * low-precision solar series, and the equation of time and the declination move during the day, so 1 minute is normal and 2 is the limit.
 */
class PrayerTimesTest extends TestCase
{
    private const TOLERANCE_MINUTES = 2;

    /** @return array<string, mixed> */
    private static function prefs(array $extra = []): array
    {
        return $extra + ['prayer_enabled' => true, 'prayer_lat' => 21.4225, 'prayer_lng' => 39.8262, 'timezone' => 'Asia/Riyadh'];
    }

    public function test_times_match_the_adhan_oracle_within_two_minutes(): void
    {
        $fixtures = json_decode((string) file_get_contents(__DIR__.'/../Fixtures/prayer-times.json'), true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame('MIT', $fixtures['license']);
        $this->assertGreaterThan(700, count($fixtures['cases']));

        $worst = [];
        $failures = [];
        foreach ($fixtures['cases'] as $case) {
            $times = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => $case['lat'], 'prayer_lng' => $case['lng'], 'timezone' => $case['tz'],
                'prayer_method' => $case['method'], 'prayer_asr' => $case['asr']])->times($case['date']);
            $label = "{$case['place']} {$case['date']} {$case['method']} {$case['asr']}";
            $this->assertNotNull($times, "{$label} has times");
            foreach ($case['expected'] as $name => $iso) {
                $minutes = ($times[$name]->getTimestamp() - CarbonImmutable::parse($iso)->getTimestamp()) / 60;
                $worst[$case['method']] = max($worst[$case['method']] ?? 0, abs($minutes));
                if (abs($minutes) > self::TOLERANCE_MINUTES) {
                    $failures[] = sprintf('%s %s differs by %+d min', $label, $name, $minutes);
                }
            }
        }

        $this->assertSame([], $failures, implode("\n", array_slice($failures, 0, 20)));
        $this->assertEqualsCanonicalizing(array_keys(PrayerTimes::METHODS), array_keys($worst), 'every method is covered by the fixtures');
    }

    public function test_hanafi_asr_is_later_than_standard_and_the_other_times_do_not_move(): void
    {
        $standard = PrayerTimes::fromPrefs(self::prefs(['prayer_method' => 'muslim_world_league']))->times('2027-03-20');
        $hanafi = PrayerTimes::fromPrefs(self::prefs(['prayer_method' => 'muslim_world_league', 'prayer_asr' => 'hanafi']))->times('2027-03-20');

        $this->assertGreaterThan(40, ($hanafi['asr']->getTimestamp() - $standard['asr']->getTimestamp()) / 60);
        foreach (['fajr', 'sunrise', 'dhuhr', 'maghrib', 'isha'] as $name) {
            $this->assertEquals($standard[$name], $hanafi[$name], $name);
        }
    }

    public function test_umm_al_qura_isha_is_90_minutes_after_maghrib_and_120_in_ramadan(): void
    {
        $prayer = PrayerTimes::fromPrefs(self::prefs());
        // Ramadan 1448 began on 2027-02-08 and ended on 2027-03-08 (Umm al-Qura calendar).
        foreach (['2027-02-10' => 120, '2027-03-05' => 120, '2027-01-25' => 90, '2027-03-12' => 90] as $date => $minutes) {
            $times = $prayer->times($date);
            $this->assertSame($minutes, ($times['isha']->getTimestamp() - $times['maghrib']->getTimestamp()) / 60, $date);
        }
        // Qatar keeps the same 90 minutes all year, and a twilight-angle method is not touched by Ramadan.
        $qatar = PrayerTimes::fromPrefs(self::prefs(['prayer_method' => 'qatar']))->times('2027-02-10');
        $this->assertSame(90, ($qatar['isha']->getTimestamp() - $qatar['maghrib']->getTimestamp()) / 60);
    }

    public function test_nothing_is_returned_when_disabled_or_without_coordinates(): void
    {
        $off = PrayerTimes::fromPrefs(self::prefs(['prayer_enabled' => false]));
        $this->assertFalse($off->enabled());
        $this->assertNull($off->times('2027-03-01'));
        $this->assertSame([], $off->windows('2027-03-01'));
        $this->assertSame([], $off->protectedWindows('2027-03-01'));
        $this->assertNull($off->iftar('2027-03-01'));

        $noPlace = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'timezone' => 'UTC']);
        $this->assertFalse($noPlace->enabled());
        $this->assertSame([], $noPlace->windows('2027-03-01'));
        $this->assertSame([], PrayerTimes::fromPrefs([])->windows('2027-03-01'));
    }

    public function test_windows_surround_the_five_prayers_but_not_sunrise(): void
    {
        $prayer = PrayerTimes::fromPrefs(self::prefs(['prayer_before' => 10, 'prayer_after' => 20]));
        $times = $prayer->times('2027-02-03'); // a Wednesday
        $windows = $prayer->windows('2027-02-03');

        $this->assertSame(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'], array_column($windows, 'prayer'));
        foreach ($windows as $window) {
            $at = $times[$window['prayer']];
            $this->assertSame(-600, $window['starts_at']->getTimestamp() - $at->getTimestamp(), $window['prayer']);
            $this->assertSame(1200, $window['ends_at']->getTimestamp() - $at->getTimestamp(), $window['prayer']);
        }
        $sunrise = $times['sunrise'];
        foreach ($windows as $window) {
            $this->assertFalse($window['starts_at'] <= $sunrise && $window['ends_at'] > $sunrise && $window['prayer'] !== 'fajr', 'sunrise has no window of its own');
        }
    }

    public function test_friday_dhuhr_gets_the_longer_jumuah_window(): void
    {
        $prayer = PrayerTimes::fromPrefs(self::prefs(['prayer_before' => 10, 'prayer_after' => 20, 'jumuah_after' => 90]));
        $friday = collect($prayer->windows('2027-02-05'))->firstWhere('prayer', 'dhuhr');   // 2027-02-05 is a Friday
        $thursday = collect($prayer->windows('2027-02-04'))->firstWhere('prayer', 'dhuhr');

        $this->assertSame(5400 + 600, $friday['ends_at']->getTimestamp() - $friday['starts_at']->getTimestamp());
        $this->assertSame(1800, $thursday['ends_at']->getTimestamp() - $thursday['starts_at']->getTimestamp());
        // Only Dhuhr changes on a Friday.
        $this->assertSame(1800, collect($prayer->windows('2027-02-05'))->firstWhere('prayer', 'asr')['ends_at']->getTimestamp() - collect($prayer->windows('2027-02-05'))->firstWhere('prayer', 'asr')['starts_at']->getTimestamp());
    }

    public function test_windows_that_overlap_are_merged_into_one(): void
    {
        // Amsterdam in winter: Dhuhr and Asr are about 2 hours apart; 60 before and 90 after makes their windows meet.
        $prayer = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => 52.3676, 'prayer_lng' => 4.9041, 'timezone' => 'Europe/Amsterdam', 'prayer_method' => 'muslim_world_league', 'prayer_before' => 60, 'prayer_after' => 90]);
        $windows = $prayer->windows('2027-12-21');

        $this->assertLessThan(5, count($windows));
        $merged = collect($windows)->first(fn (array $w) => count($w['prayers']) > 1);
        $this->assertNotNull($merged, 'two prayers share a window');
        $this->assertSame($merged['prayers'][0], $merged['prayer']);
        for ($i = 1; $i < count($windows); $i++) {
            $this->assertTrue($windows[$i]['starts_at'] > $windows[$i - 1]['ends_at'], 'merged windows never overlap or touch');
        }
        $times = $prayer->times('2027-12-21');
        foreach (PrayerTimes::PRAYERS as $name) {
            $this->assertTrue(collect($windows)->contains(fn (array $w) => $w['starts_at'] <= $times[$name] && $w['ends_at'] >= $times[$name]), "{$name} is inside a window");
        }
    }

    public function test_dst_days_move_the_local_clock_but_not_the_sun(): void
    {
        $prayer = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => 52.3676, 'prayer_lng' => 4.9041, 'timezone' => 'Europe/Amsterdam', 'prayer_method' => 'muslim_world_league']);
        $local = fn (string $date, string $name) => $prayer->times($date)[$name]->setTimezone('Europe/Amsterdam');

        // Clocks go forward on 2027-03-28 and back on 2027-10-31: Dhuhr is at 12:xx local the day before and 13:xx (spring) or 12:xx (autumn) after.
        $this->assertSame(12, $local('2027-03-27', 'dhuhr')->hour);
        $this->assertSame(13, $local('2027-03-28', 'dhuhr')->hour);
        $this->assertSame(13, $local('2027-10-30', 'dhuhr')->hour);
        $this->assertSame(12, $local('2027-10-31', 'dhuhr')->hour);
        // The sun itself moves by about 1 minute a day: the instants of consecutive days are about 24 hours apart.
        $gap = ($prayer->times('2027-03-28')['dhuhr']->getTimestamp() - $prayer->times('2027-03-27')['dhuhr']->getTimestamp()) / 60;
        $this->assertEqualsWithDelta(24 * 60, $gap, 2);
        // The windows of the DST day are real instants on that local date.
        foreach (['2027-03-28', '2027-10-31'] as $date) {
            $windows = $prayer->windows($date);
            $this->assertCount(5, $windows);
            $this->assertSame($date, $windows[0]['starts_at']->setTimezone('Europe/Amsterdam')->toDateString(), 'Fajr is on the same local date');
        }
    }

    public function test_midsummer_at_high_latitude_uses_the_angle_based_night_portion_and_isha_belongs_to_the_evening(): void
    {
        $prayer = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => 59.9139, 'prayer_lng' => 10.7522, 'timezone' => 'Europe/Oslo', 'prayer_method' => 'muslim_world_league']);
        $times = $prayer->times('2027-06-21');
        $nextSunrise = $prayer->times('2027-06-22')['sunrise'];
        $night = $times['maghrib']->diffInSeconds($nextSunrise);

        // The 17 and 18 degree angles are never reached in Oslo at midsummer: Isha and Fajr are the 17/60 and 18/60 portions of the night.
        $this->assertEqualsWithDelta(17 / 60 * $night, $times['isha']->getTimestamp() - $times['maghrib']->getTimestamp(), 120);
        $this->assertEqualsWithDelta(18 / 60 * $night, $times['sunrise']->getTimestamp() - $times['fajr']->getTimestamp(), 120);
        // Isha is after local midnight, yet it is still the prayer of 21 June's evening: it is in windows('2027-06-21') and its window is
        // protected when a planner looks at the early hours of 22 June.
        $this->assertSame('2027-06-22', $times['isha']->setTimezone('Europe/Oslo')->toDateString());
        $isha = collect($prayer->windows('2027-06-21'))->firstWhere('prayer', 'isha');
        $this->assertSame('2027-06-22', $isha['ends_at']->setTimezone('Europe/Oslo')->toDateString());
        $earlyHours = $prayer->protectedIntervals(CarbonImmutable::parse('2027-06-22 00:00', 'Europe/Oslo'), CarbonImmutable::parse('2027-06-22 06:00', 'Europe/Oslo'));
        $this->assertTrue(collect($earlyHours)->contains(fn (array $s) => $s[0] <= $times['isha'] && $s[1] > $times['isha']));
        // And a planner looking at the early hours of 21 June sees that day's own Fajr, not the previous evening twice.
        $this->assertSame('2027-06-21', $times['fajr']->setTimezone('Europe/Oslo')->toDateString());
    }

    public function test_the_sun_that_never_sets_gives_no_times_and_no_windows(): void
    {
        $prayer = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => 70.0, 'prayer_lng' => 25.0, 'timezone' => 'Europe/Oslo']);
        $this->assertNull($prayer->times('2027-06-21'));
        $this->assertSame([], $prayer->windows('2027-06-21'));
        $this->assertSame([], $prayer->protectedWindows('2027-06-21'));
    }

    public function test_the_southern_hemisphere_and_the_dateline_side_of_utc_use_the_right_local_day(): void
    {
        $sydney = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => -33.8688, 'prayer_lng' => 151.2093, 'timezone' => 'Australia/Sydney', 'prayer_method' => 'muslim_world_league']);
        $auckland = PrayerTimes::fromPrefs(['prayer_enabled' => true, 'prayer_lat' => -36.8485, 'prayer_lng' => 174.7633, 'timezone' => 'Pacific/Auckland', 'prayer_method' => 'muslim_world_league']);
        foreach ([$sydney, $auckland] as $prayer) {
            foreach (['2027-01-15', '2027-06-21'] as $date) {
                foreach ($prayer->times($date) as $name => $at) {
                    $this->assertSame($date, $at->setTimezone($prayer->timezone())->toDateString(), "{$name} of {$date} is on that local date");
                }
            }
        }
        // Winter in the south: the sun is up for less than 11 hours.
        $winter = $sydney->times('2027-06-21');
        $this->assertLessThan(11 * 3600, $winter['maghrib']->getTimestamp() - $winter['sunrise']->getTimestamp());
    }

    public function test_the_settings_are_clamped_to_their_ranges(): void
    {
        $prayer = PrayerTimes::fromPrefs(self::prefs(['prayer_before' => 500, 'prayer_after' => -4, 'jumuah_after' => 1, 'iftar_minutes' => 9999, 'prayer_method' => 'nonsense']));
        $this->assertSame(60, $prayer->before());
        $this->assertSame(0, $prayer->after());
        $this->assertSame(30, $prayer->jumuahAfter());
        $this->assertSame(120, $prayer->iftarMinutes());
        $this->assertSame('umm_al_qura', $prayer->method());
    }
}
