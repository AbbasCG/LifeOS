<?php

namespace App\Services;

use App\Models\User;
use Carbon\CarbonImmutable;
use DateTimeZone;

/**
 * Prayer times and the protected windows around them, computed locally from the standard solar-position formulas
 * (Meeus / NOAA low-precision series: declination, equation of time, hour angle). Nothing leaves the server and no
 * dependency is used. The coordinates are only read from the user's own preferences and are never logged or returned.
 *
 * Conventions
 * - Sunrise and Maghrib use a solar altitude of -0.8333 degrees (refraction plus the sun's radius); elevation is ignored.
 * - Fajr and Isha use the method's twilight angle, or for Isha a fixed number of minutes after Maghrib (Umm al-Qura and
 *   Qatar: 90; Umm al-Qura adds 30 on the days of Ramadan).
 * - High latitudes: when a twilight angle is never reached, or is reached earlier than the "angle-based" limit, Fajr and
 *   Isha are held at angle/60 of the night (sunset to the next sunrise) from sunrise and sunset. Where the sun never rises
 *   or sets on that day (polar day or night) no time can be given and the day has no times and no windows.
 * - Asr uses the shadow factor 1 (standard) or 2 (Hanafi).
 * - Methods carry the small per-method offsets of their published conventions (for example Dhuhr +1 minute, the
 *   Diyanet offsets for Turkey), so times are comparable with the usual timetables.
 * - Times are rounded to the nearest minute and returned as UTC instants.
 *
 * A prayer day is the user's local calendar date. Isha can fall after local midnight at high latitudes in summer; it
 * still belongs to the evening of the date that was asked for, so windows(D) may end after midnight and a planner that
 * looks at a time range also asks for the previous date (see protectedIntervals()).
 */
final class PrayerTimes
{
    /**
     * Twilight angles in degrees, or an Isha interval in minutes after Maghrib, and per-method adjustments in minutes.
     *
     * @var array<string, array{fajr: float, isha: float|null, interval: int, adjust: array<string, int>}>
     */
    public const METHODS = [
        'umm_al_qura' => ['fajr' => 18.5, 'isha' => null, 'interval' => 90, 'adjust' => []],
        'muslim_world_league' => ['fajr' => 18.0, 'isha' => 17.0, 'interval' => 0, 'adjust' => ['dhuhr' => 1]],
        'egyptian' => ['fajr' => 19.5, 'isha' => 17.5, 'interval' => 0, 'adjust' => ['dhuhr' => 1]],
        'karachi' => ['fajr' => 18.0, 'isha' => 18.0, 'interval' => 0, 'adjust' => ['dhuhr' => 1]],
        'north_america' => ['fajr' => 15.0, 'isha' => 15.0, 'interval' => 0, 'adjust' => ['dhuhr' => 1]],
        'kuwait' => ['fajr' => 18.0, 'isha' => 17.5, 'interval' => 0, 'adjust' => []],
        'qatar' => ['fajr' => 18.0, 'isha' => null, 'interval' => 90, 'adjust' => []],
        'turkey' => ['fajr' => 18.0, 'isha' => 17.0, 'interval' => 0, 'adjust' => ['sunrise' => -7, 'dhuhr' => 5, 'asr' => 4, 'maghrib' => 7]],
    ];

    public const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

    /** Solar altitude of sunrise and sunset, degrees. */
    private const HORIZON = -0.8333;

    /** @var array<string, array<string, CarbonImmutable>|null> */
    private array $cache = [];

    /** @param array<string, mixed> $prefs the user's stored preferences */
    private function __construct(private array $prefs) {}

    public static function for(User $user): self
    {
        return new self($user->preferences());
    }

    /** @param array<string, mixed> $prefs */
    public static function fromPrefs(array $prefs): self
    {
        return new self($prefs);
    }

    public function enabled(): bool
    {
        return ($this->prefs['prayer_enabled'] ?? false) === true
            && is_numeric($this->prefs['prayer_lat'] ?? null) && is_numeric($this->prefs['prayer_lng'] ?? null);
    }

    public function timezone(): string
    {
        return (string) ($this->prefs['timezone'] ?? 'UTC');
    }

    public function method(): string
    {
        $method = $this->prefs['prayer_method'] ?? 'umm_al_qura';

        return is_string($method) && isset(self::METHODS[$method]) ? $method : 'umm_al_qura';
    }

    public function before(): int
    {
        return $this->int('prayer_before', 10, 0, 60);
    }

    public function after(): int
    {
        return $this->int('prayer_after', 20, 0, 90);
    }

    public function jumuahAfter(): int
    {
        return $this->int('jumuah_after', 75, 30, 180);
    }

    public function iftarMinutes(): int
    {
        return $this->int('iftar_minutes', 45, 15, 120);
    }

    /**
     * The five prayers and sunrise for one local date as UTC instants, or null when prayer times are off or the sun does
     * not rise and set on that date at this latitude.
     *
     * @return array{fajr: CarbonImmutable, sunrise: CarbonImmutable, dhuhr: CarbonImmutable, asr: CarbonImmutable, maghrib: CarbonImmutable, isha: CarbonImmutable}|null
     */
    public function times(string $date): ?array
    {
        if (! $this->enabled()) {
            return null;
        }

        return $this->cache[$date] ??= $this->calculate($date);
    }

    /**
     * Soft windows of the five obligatory prayers (not sunrise) of one local date: [time - before, time + after], on
     * Friday Dhuhr [time - before, time + jumuah_after]. Windows that overlap or touch are merged into one.
     *
     * @return list<array{prayer: string, prayers: list<string>, starts_at: CarbonImmutable, ends_at: CarbonImmutable}>
     */
    public function windows(string $date): array
    {
        $times = $this->times($date);
        if ($times === null) {
            return [];
        }
        $friday = CarbonImmutable::parse($date, $this->timezone())->dayOfWeek === CarbonImmutable::FRIDAY;
        $raw = [];
        foreach (self::PRAYERS as $prayer) {
            $after = $prayer === 'dhuhr' && $friday ? $this->jumuahAfter() : $this->after();
            $raw[] = ['prayers' => [$prayer], 'starts_at' => $times[$prayer]->subMinutes($this->before()), 'ends_at' => $times[$prayer]->addMinutes($after)];
        }
        usort($raw, fn (array $a, array $b) => $a['starts_at'] <=> $b['starts_at']);
        $merged = [];
        foreach ($raw as $window) {
            $last = array_key_last($merged);
            if ($last !== null && $window['starts_at'] <= $merged[$last]['ends_at']) {
                $merged[$last]['ends_at'] = max($merged[$last]['ends_at'], $window['ends_at']);
                $merged[$last]['prayers'] = [...$merged[$last]['prayers'], ...$window['prayers']];

                continue;
            }
            $merged[] = $window;
        }

        return array_map(fn (array $w) => ['prayer' => $w['prayers'][0]] + $w, $merged);
    }

    /**
     * The iftar window of a local date: [maghrib, maghrib + iftar_minutes], only on a day of Ramadan (per the user's
     * Ramadan mode) and only when prayer times are on, because it hangs off Maghrib.
     *
     * @return array{starts_at: CarbonImmutable, ends_at: CarbonImmutable}|null
     */
    public function iftar(string $date): ?array
    {
        $times = $this->times($date);
        if ($times === null || ! Ramadan::activeFor($this->prefs, $date)) {
            return null;
        }

        return ['starts_at' => $times['maghrib'], 'ends_at' => $times['maghrib']->addMinutes($this->iftarMinutes())];
    }

    /**
     * Everything a planner must keep clear on one local date: the prayer windows and the iftar window, merged.
     *
     * @return list<array{0: CarbonImmutable, 1: CarbonImmutable}>
     */
    public function protectedWindows(string $date): array
    {
        $spans = array_map(fn (array $w) => [$w['starts_at'], $w['ends_at']], $this->windows($date));
        if ($iftar = $this->iftar($date)) {
            $spans[] = [$iftar['starts_at'], $iftar['ends_at']];
        }

        return self::merge($spans);
    }

    /**
     * Protected spans that touch [from, to), looking at the local date before $from too (Isha after midnight).
     *
     * @return list<array{0: CarbonImmutable, 1: CarbonImmutable}>
     */
    public function protectedIntervals(CarbonImmutable $from, CarbonImmutable $to): array
    {
        if (! $this->enabled() || $to <= $from) {
            return [];
        }
        $first = $from->setTimezone($this->timezone())->startOfDay()->subDay();
        $last = $to->setTimezone($this->timezone())->startOfDay();
        $spans = [];
        for ($day = $first; $day <= $last; $day = $day->addDay()) {
            foreach ($this->protectedWindows($day->toDateString()) as $span) {
                if ($span[0] < $to && $span[1] > $from) {
                    $spans[] = $span;
                }
            }
        }

        return self::merge($spans);
    }

    /**
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $spans
     * @return list<array{0: CarbonImmutable, 1: CarbonImmutable}>
     */
    public static function merge(array $spans): array
    {
        usort($spans, fn (array $a, array $b) => $a[0] <=> $b[0]);
        $out = [];
        foreach ($spans as $span) {
            $last = array_key_last($out);
            if ($last !== null && $span[0] <= $out[$last][1]) {
                $out[$last][1] = max($out[$last][1], $span[1]);

                continue;
            }
            $out[] = $span;
        }

        return $out;
    }

    private function int(string $key, int $default, int $min, int $max): int
    {
        $value = $this->prefs[$key] ?? $default;

        return is_numeric($value) ? max($min, min($max, (int) $value)) : $default;
    }

    /** @return array{fajr: CarbonImmutable, sunrise: CarbonImmutable, dhuhr: CarbonImmutable, asr: CarbonImmutable, maghrib: CarbonImmutable, isha: CarbonImmutable}|null */
    private function calculate(string $date): ?array
    {
        $m = self::METHODS[$this->method()];
        $shadow = ($this->prefs['prayer_asr'] ?? 'standard') === 'hanafi' ? 2 : 1;
        $lat = (float) $this->prefs['prayer_lat'];
        $sunrise = $this->event($date, self::HORIZON, true);
        $sunset = $this->event($date, self::HORIZON, false);
        $nextSunrise = $this->event(CarbonImmutable::parse($date, 'UTC')->addDay()->toDateString(), self::HORIZON, true);
        if ($sunrise === null || $sunset === null || $nextSunrise === null) {
            return null;
        }
        $transit = $this->transit($date);
        $asr = $this->event($date, fn (float $decl) => rad2deg(atan(1 / ($shadow + tan(abs(deg2rad($lat) - $decl))))), false);
        if ($asr === null) {
            return null;
        }
        $night = $nextSunrise - $sunset;

        $fajr = $this->event($date, -$m['fajr'], true);
        $safeFajr = $sunrise - $m['fajr'] / 60 * $night;
        if ($fajr === null || $fajr < $safeFajr) {
            $fajr = $safeFajr;
        }
        if ($m['interval'] > 0) {
            $isha = $sunset + ($m['interval'] + ($this->ramadanIsha($date) ? 30 : 0)) * 60;
        } else {
            $isha = $this->event($date, -$m['isha'], false);
            $safeIsha = $sunset + $m['isha'] / 60 * $night;
            if ($isha === null || $isha > $safeIsha) {
                $isha = $safeIsha;
            }
        }

        $at = fn (float $seconds, string $name) => CarbonImmutable::createFromTimestampUTC((int) (floor(($seconds + ($m['adjust'][$name] ?? 0) * 60 + 30) / 60) * 60));

        return [
            'fajr' => $at($fajr, 'fajr'), 'sunrise' => $at($sunrise, 'sunrise'), 'dhuhr' => $at($transit, 'dhuhr'),
            'asr' => $at($asr, 'asr'), 'maghrib' => $at($sunset, 'maghrib'), 'isha' => $at($isha, 'isha'),
        ];
    }

    /** Umm al-Qura lengthens the Isha interval to 120 minutes on the days of Ramadan, by the calendar rather than the planning mode. */
    private function ramadanIsha(string $date): bool
    {
        return $this->method() === 'umm_al_qura' && Ramadan::onDate($date, (int) ($this->prefs['hijri_offset'] ?? 0));
    }

    /**
     * Mean solar noon (UTC unix seconds) of the local date: the solar noon closest to 12:00 on the local clock.
     */
    private function meanNoon(string $date): float
    {
        $lng = (float) $this->prefs['prayer_lng'];
        $utcMidnight = CarbonImmutable::parse($date, 'UTC')->getTimestamp();
        $mean = $utcMidnight + (12 - $lng / 15) * 3600;
        $localNoon = CarbonImmutable::parse($date.' 12:00:00', new DateTimeZone($this->timezone()))->getTimestamp();

        return $mean + round(($localNoon - $mean) / 86400) * 86400;
    }

    /** Solar transit (UTC unix seconds) of the local date. */
    private function transit(string $date): float
    {
        $mean = $this->meanNoon($date);
        $t = $mean;
        for ($i = 0; $i < 3; $i++) {
            $t = $mean - self::sun($t)[1] * 60;
        }

        return $t;
    }

    /**
     * The instant (UTC unix seconds) the sun passes the given altitude on the morning or the evening of the local date,
     * or null when it does not reach it that day. The altitude may depend on the declination (Asr).
     *
     * @param  float|callable(float): float  $altitude  degrees, or a function of the declination in radians
     */
    private function event(string $date, float|callable $altitude, bool $morning): ?float
    {
        $mean = $this->meanNoon($date);
        $phi = deg2rad((float) $this->prefs['prayer_lat']);
        $t = $mean;
        for ($i = 0; $i < 4; $i++) {
            [$decl, $eot] = self::sun($t);
            $alt = deg2rad(is_callable($altitude) ? $altitude($decl) : $altitude);
            $cos = (sin($alt) - sin($phi) * sin($decl)) / (cos($phi) * cos($decl));
            if ($cos < -1 || $cos > 1) {
                return null;
            }
            $hours = rad2deg(acos($cos)) / 15;
            $t = $mean - $eot * 60 + ($morning ? -1 : 1) * $hours * 3600;
        }

        return $t;
    }

    /**
     * Declination (radians) and equation of time (minutes) of the sun at a UTC unix instant.
     *
     * @return array{0: float, 1: float}
     */
    private static function sun(float $unix): array
    {
        $jd = $unix / 86400 + 2440587.5;
        $T = ($jd - 2451545.0) / 36525.0;
        $L0 = fmod(280.46646 + 36000.76983 * $T + 0.0003032 * $T * $T, 360.0);
        $M = deg2rad(357.52911 + 35999.05029 * $T - 0.0001537 * $T * $T);
        $e = 0.016708634 - 0.000042037 * $T - 0.0000001267 * $T * $T;
        $C = (1.914602 - 0.004817 * $T - 0.000014 * $T * $T) * sin($M) + (0.019993 - 0.000101 * $T) * sin(2 * $M) + 0.000289 * sin(3 * $M);
        $omega = deg2rad(125.04 - 1934.136 * $T);
        $lambda = deg2rad($L0 + $C - 0.00569 - 0.00478 * sin($omega));
        $eps0 = 23 + (26 + (21.448 - $T * (46.815 + $T * (0.00059 - $T * 0.001813))) / 60) / 60;
        $eps = deg2rad($eps0 + 0.00256 * cos($omega));
        $decl = asin(sin($eps) * sin($lambda));
        $y = tan($eps / 2) ** 2;
        $l0 = deg2rad($L0);
        $eot = 4 * rad2deg($y * sin(2 * $l0) - 2 * $e * sin($M) + 4 * $e * $y * sin($M) * cos(2 * $l0) - 0.5 * $y * $y * sin(4 * $l0) - 1.25 * $e * $e * sin(2 * $M));

        return [$decl, $eot];
    }
}
