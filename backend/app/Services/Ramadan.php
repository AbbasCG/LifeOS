<?php

namespace App\Services;

use App\Models\User;
use DateTime;
use DateTimeZone;
use IntlCalendar;

/**
 * Ramadan mode. `ramadan_mode` is 'off' (default), 'on' (always treated as Ramadan) or 'auto': the Umm al-Qura Hijri month
 * is 9, moved by the user's own `hijri_offset` days (their moon-sighting adjustment, the same shift the Hijri dates in the
 * app use). Needs ext-intl; without the calendar data 'auto' is simply never active.
 */
final class Ramadan
{
    public const MODES = ['off', 'auto', 'on'];

    public static function active(User $user, string $date): bool
    {
        return self::activeFor($user->preferences(), $date);
    }

    /**
     * @param  array<string, mixed>  $prefs  preferences, or a planning config (it uses the same key names)
     * @param  string  $date  the user's local date, Y-m-d
     */
    public static function activeFor(array $prefs, string $date): bool
    {
        return match ($prefs['ramadan_mode'] ?? 'off') {
            'on' => true,
            'auto' => self::onDate($date, (int) ($prefs['hijri_offset'] ?? 0)),
            default => false,
        };
    }

    /**
     * Whether the date, moved by $offset days, falls in Hijri month 9 of the Umm al-Qura calendar.
     */
    public static function onDate(string $date, int $offset = 0): bool
    {
        if (! class_exists(IntlCalendar::class)) {
            return false;
        }
        try {
            $at = (new DateTime($date.' 12:00:00', new DateTimeZone('UTC')))->modify(sprintf('%+d days', $offset));
            $calendar = IntlCalendar::fromDateTime($at, 'en@calendar=islamic-umalqura');

            // FIELD_MONTH is zero-based: Ramadan is 8.
            return $calendar !== null && $calendar->get(IntlCalendar::FIELD_MONTH) === 8;
        } catch (\Throwable) {
            return false;
        }
    }
}
