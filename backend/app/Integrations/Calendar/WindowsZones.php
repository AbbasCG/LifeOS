<?php

namespace App\Integrations\Calendar;

use IntlTimeZone;

/**
 * Translates the timezone names Microsoft Graph reports (Windows names such as "W. Europe Standard Time") to IANA
 * identifiers using ICU's CLDR mapping, so organiser timezones from Outlook can be compared like Google's.
 */
class WindowsZones
{
    /** ICU still returns some legacy IANA aliases; PHP lists only the current names. */
    private const ALIASES = ['Asia/Calcutta' => 'Asia/Kolkata', 'Asia/Katmandu' => 'Asia/Kathmandu', 'Asia/Rangoon' => 'Asia/Yangon', 'Asia/Saigon' => 'Asia/Ho_Chi_Minh', 'Etc/UTC' => 'UTC', 'Etc/GMT' => 'UTC', 'America/Buenos_Aires' => 'America/Argentina/Buenos_Aires', 'Europe/Kiev' => 'Europe/Kyiv', 'Pacific/Truk' => 'Pacific/Chuuk', 'Atlantic/Faeroe' => 'Atlantic/Faroe'];

    /**
     * IANA name for a Windows or IANA zone, or null when it cannot be resolved (e.g. "Customized Time Zone").
     */
    public static function toIana(?string $zone): ?string
    {
        $zone = trim((string) $zone);
        if ($zone === '') {
            return null;
        }
        $valid = array_flip(timezone_identifiers_list());
        $candidate = isset($valid[$zone]) ? $zone : (class_exists(IntlTimeZone::class) ? IntlTimeZone::getIDForWindowsID($zone) : false);
        if (! is_string($candidate) || $candidate === '') {
            return self::ALIASES[$zone] ?? null;
        }
        $candidate = self::ALIASES[$candidate] ?? $candidate;

        return isset($valid[$candidate]) ? $candidate : null;
    }
}
