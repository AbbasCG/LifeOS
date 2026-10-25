<?php

namespace App\Integrations\Calendar;

use App\Models\CalendarEvent;
use App\Services\CalendarService;
use Carbon\CarbonImmutable;
use DateInterval;
use Throwable;

/**
 * Parses an iCalendar (RFC 5545) feed into read-only occurrences inside a window.
 *
 * Supported: VEVENT with DTSTART/DTEND/DURATION (UTC, TZID or floating; all-day dates), RRULE with FREQ, INTERVAL,
 * COUNT, UNTIL and plain weekday BYDAY for weekly rules (expanded by LifeOS' own recurrence engine), EXDATE,
 * RECURRENCE-ID overrides, STATUS:CANCELLED and TRANSP:TRANSPARENT. Rules beyond that (BYSETPOS, ordinal BYDAY,
 * BYMONTHDAY lists, RDATE …) are not guessed: such series are skipped and counted so the hub can say so.
 */
class IcsParser
{
    public const MAX_EVENTS = 5000;

    /** @var array<string, int> RFC 5545 weekday codes to Carbon day numbers (0 = Sunday) */
    private const WEEKDAYS = ['SU' => 0, 'MO' => 1, 'TU' => 2, 'WE' => 3, 'TH' => 4, 'FR' => 5, 'SA' => 6];

    public function __construct(private CalendarService $calendar) {}

    /**
     * @return array{name: string|null, timezone: string|null, events: list<array<string, mixed>>, skipped: int}
     */
    public function parse(string $ics, string $calendarId, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): array
    {
        $lines = preg_split('/\r\n|\n|\r/', preg_replace('/\r?\n[ \t]/', '', $ics) ?? '') ?: [];
        if (! str_starts_with(strtoupper(trim($lines[0] ?? '')), 'BEGIN:VCALENDAR')) {
            throw new ProviderException('This address did not return an iCalendar (.ics) feed.');
        }
        $name = null;
        $feedZone = null;
        $vevents = [];
        $current = null;
        $depth = 0;
        foreach ($lines as $line) {
            if ($line === '') {
                continue;
            }
            [$prop, $params, $value] = $this->property($line);
            if ($prop === 'BEGIN') {
                $depth++;
                if (strtoupper($value) === 'VEVENT') {
                    $current = [];
                }

                continue;
            }
            if ($prop === 'END') {
                $depth--;
                if (strtoupper($value) === 'VEVENT' && $current !== null) {
                    $vevents[] = $current;
                    $current = null;
                }

                continue;
            }
            if ($current !== null) {
                $current[$prop][] = ['params' => $params, 'value' => $value];
            } elseif ($depth === 1 && $prop === 'X-WR-CALNAME') {
                $name = mb_substr($this->text($value), 0, 200);
            } elseif ($depth === 1 && $prop === 'X-WR-TIMEZONE') {
                $feedZone = $this->zone($value);
            }
        }
        $floating = $feedZone ?? $userTimezone;

        // Overrides of single occurrences, keyed by UID and original start.
        $overrides = [];
        $masters = [];
        foreach ($vevents as $v) {
            $uid = $this->first($v, 'UID') ?? md5(json_encode($v) ?: '');
            if (isset($v['RECURRENCE-ID'])) {
                $original = $this->time($v['RECURRENCE-ID'][0], $floating, $userTimezone);
                if ($original) {
                    $overrides[$uid][$original['at']->getTimestamp()] = $v;
                }

                continue;
            }
            $masters[] = [$uid, $v];
        }

        $events = [];
        $skipped = 0;
        foreach ($masters as [$uid, $v]) {
            if (count($events) >= self::MAX_EVENTS) {
                break;
            }
            $start = isset($v['DTSTART']) ? $this->time($v['DTSTART'][0], $floating, $userTimezone) : null;
            if (! $start) {
                continue;
            }
            $length = $this->length($v, $start, $floating, $userTimezone);
            $rule = $this->first($v, 'RRULE');
            $exdates = [];
            foreach ($v['EXDATE'] ?? [] as $ex) {
                foreach (explode(',', $ex['value']) as $value) {
                    $t = $this->time(['params' => $ex['params'], 'value' => $value], $floating, $userTimezone);
                    if ($t) {
                        $exdates[$t['at']->getTimestamp()] = true;
                    }
                }
            }
            $starts = [$start['at']];
            if ($rule !== null) {
                $recurrence = $this->recurrence($rule, $start);
                if ($recurrence === null) {
                    $skipped++;

                    continue;
                }
                $starts = $this->expand($start, $recurrence, $from->subSeconds($length), $to);
            }
            foreach ($starts as $occurrence) {
                $key = $occurrence->getTimestamp();
                if (isset($exdates[$key])) {
                    continue;
                }
                $source = $overrides[$uid][$key] ?? $v;
                unset($overrides[$uid][$key]);
                $row = $this->row($source, $uid, $calendarId, $occurrence, $rule !== null, $floating, $userTimezone, $start['all_day'] ? null : $start['zone']);
                if ($row && $row['ends_at'] > $from && $row['starts_at'] < $to) {
                    $events[] = $row;
                }
            }
        }
        // Overrides whose original occurrence is not produced by the master (moved in from elsewhere) still count.
        foreach ($overrides as $uid => $list) {
            foreach ($list as $key => $v) {
                $row = $this->row($v, (string) $uid, $calendarId, CarbonImmutable::createFromTimestampUTC($key), true, $floating, $userTimezone, null);
                if ($row && $row['ends_at'] > $from && $row['starts_at'] < $to && count($events) < self::MAX_EVENTS) {
                    $events[] = $row;
                }
            }
        }

        return ['name' => $name, 'timezone' => $feedZone, 'events' => $events, 'skipped' => $skipped];
    }

    /**
     * @param  array<string, list<array{params: array<string, string>, value: string}>>  $v
     * @return array<string, mixed>|null
     */
    private function row(array $v, string $uid, string $calendarId, CarbonImmutable $original, bool $recurring, string $floating, string $userTimezone, ?string $zone): ?array
    {
        if (strtoupper((string) $this->first($v, 'STATUS')) === 'CANCELLED' || strtoupper((string) $this->first($v, 'TRANSP')) === 'TRANSPARENT') {
            return null;
        }
        $start = isset($v['DTSTART']) ? $this->time($v['DTSTART'][0], $floating, $userTimezone) : null;
        if (! $start) {
            return null;
        }
        // For a series occurrence the master's DTSTART is the first one; the occurrence keeps its duration.
        $isOverride = isset($v['RECURRENCE-ID']);
        $at = $recurring && ! $isOverride ? $original : $start['at'];
        $length = $this->length($v, $start, $floating, $userTimezone);

        return [
            'id' => mb_substr(hash('sha256', $uid).':'.$original->getTimestamp(), 0, 512),
            'calendar_id' => $calendarId,
            'title' => mb_substr($this->text((string) ($this->first($v, 'SUMMARY') ?? '(busy)')), 0, 500) ?: '(busy)',
            'starts_at' => $at->utc(),
            'ends_at' => $at->addSeconds(max(0, $length))->utc(),
            'all_day' => $start['all_day'],
            'show_as' => 'busy',
            'ical_uid' => mb_substr($uid, 0, 1024),
            'series_id' => $recurring ? mb_substr(hash('sha256', $uid), 0, 512) : null,
            'original_start' => $recurring ? $original->utc() : null,
            'timezone' => $start['all_day'] ? null : ($start['zone'] ?? $zone),
        ];
    }

    /**
     * Duration in seconds from DTEND or DURATION; all-day events default to one day, timed ones to zero.
     *
     * @param  array<string, list<array{params: array<string, string>, value: string}>>  $v
     * @param  array{at: CarbonImmutable, all_day: bool, zone: ?string}  $start
     */
    private function length(array $v, array $start, string $floating, string $userTimezone): int
    {
        if (isset($v['DTEND']) && ($end = $this->time($v['DTEND'][0], $floating, $userTimezone))) {
            return max(0, $end['at']->getTimestamp() - $start['at']->getTimestamp());
        }
        if ($duration = $this->first($v, 'DURATION')) {
            try {
                $interval = new DateInterval(ltrim(strtoupper($duration), '+'));

                return max(0, $start['at']->add($interval)->getTimestamp() - $start['at']->getTimestamp());
            } catch (Throwable) {
                return 0;
            }
        }

        return $start['all_day'] ? 86400 : 0;
    }

    /**
     * Map an RRULE onto LifeOS' recurrence format, or null when it uses parts LifeOS cannot expand faithfully.
     *
     * @param  array{at: CarbonImmutable, all_day: bool, zone: ?string}  $start
     * @return array<string, mixed>|null
     */
    private function recurrence(string $rule, array $start): ?array
    {
        $parts = [];
        foreach (explode(';', strtoupper($rule)) as $pair) {
            [$k, $val] = array_pad(explode('=', $pair, 2), 2, '');
            if ($k !== '') {
                $parts[$k] = $val;
            }
        }
        $freq = ['DAILY' => 'daily', 'WEEKLY' => 'weekly', 'MONTHLY' => 'monthly', 'YEARLY' => 'yearly'][$parts['FREQ'] ?? ''] ?? null;
        if ($freq === null || array_diff(array_keys($parts), ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST', 'BYMONTHDAY', 'BYMONTH'])) {
            return null;
        }
        $local = $start['at'];
        // Redundant parts that only restate DTSTART are fine; anything else changes the pattern.
        if (isset($parts['BYMONTHDAY']) && ((int) $parts['BYMONTHDAY'] !== $local->day || ! in_array($freq, ['monthly', 'yearly'], true))) {
            return null;
        }
        if (isset($parts['BYMONTH']) && ((int) $parts['BYMONTH'] !== $local->month || $freq !== 'yearly')) {
            return null;
        }
        $weekdays = null;
        if (isset($parts['BYDAY'])) {
            $days = explode(',', $parts['BYDAY']);
            if ($freq !== 'weekly') {
                return null;
            }
            $weekdays = [];
            foreach ($days as $d) {
                if (! isset(self::WEEKDAYS[$d])) {
                    return null;
                }
                $weekdays[] = self::WEEKDAYS[$d];
            }
        }
        $until = null;
        if (! empty($parts['UNTIL'])) {
            try {
                $until = strlen($parts['UNTIL']) === 8
                    ? CarbonImmutable::createFromFormat('Ymd', $parts['UNTIL'], $local->timezone)->endOfDay()
                    : CarbonImmutable::parse($parts['UNTIL'], str_ends_with($parts['UNTIL'], 'Z') ? 'UTC' : $local->timezone);
            } catch (Throwable) {
                return null;
            }
        }

        return array_filter(['freq' => $freq, 'interval' => max(1, (int) ($parts['INTERVAL'] ?? 1)), 'count' => isset($parts['COUNT']) ? max(1, (int) $parts['COUNT']) : null, 'by_weekday' => $weekdays, 'until_at' => $until], fn ($x) => $x !== null);
    }

    /**
     * @param  array{at: CarbonImmutable, all_day: bool, zone: ?string}  $start
     *                                                                           Occurrence starts in (from, to): older ones are skipped so long-running series stay within the cap.
     * @param  array<string, mixed>  $recurrence
     * @return list<CarbonImmutable>
     */
    private function expand(array $start, array $recurrence, CarbonImmutable $from, CarbonImmutable $to): array
    {
        $zone = $start['at']->timezoneName;
        $until = $recurrence['until_at'] ?? null;
        unset($recurrence['until_at']);
        if ($until) {
            $recurrence['until'] = $until->setTimezone($zone)->toDateString();
        }
        $event = new CalendarEvent(['starts_at' => $start['at']->utc(), 'timezone' => $zone]);
        $event->recurrence = $recurrence;
        $out = [];
        foreach ($this->calendar->occurrenceStarts($event, $to) as $occurrence) {
            if ($until && $occurrence > $until) {
                break;
            }
            if ($occurrence <= $from) {
                continue;
            }
            $out[] = $occurrence->setTimezone($zone);
            if (count($out) >= self::MAX_EVENTS) {
                break;
            }
        }

        return $out;
    }

    /**
     * @param  array{params: array<string, string>, value: string}  $prop
     * @return array{at: CarbonImmutable, all_day: bool, zone: ?string}|null
     */
    private function time(array $prop, string $floating, string $userTimezone): ?array
    {
        $value = trim($prop['value']);
        try {
            if (($prop['params']['VALUE'] ?? '') === 'DATE' || preg_match('/^\d{8}$/', $value)) {
                // All-day: midnight to midnight in the user's own zone, like other all-day imports.
                return ['at' => CarbonImmutable::createFromFormat('!Ymd', substr($value, 0, 8), $userTimezone), 'all_day' => true, 'zone' => null];
            }
            if (str_ends_with($value, 'Z')) {
                return ['at' => CarbonImmutable::createFromFormat('Ymd\THis\Z', $value, 'UTC'), 'all_day' => false, 'zone' => 'UTC'];
            }
            $zone = isset($prop['params']['TZID']) ? ($this->zone($prop['params']['TZID']) ?? $floating) : $floating;

            return ['at' => CarbonImmutable::createFromFormat('Ymd\THis', $value, $zone), 'all_day' => false, 'zone' => $zone];
        } catch (Throwable) {
            return null;
        }
    }

    /** IANA zone from an IANA, Windows or vendor-prefixed TZID ("/mozilla.org/20050126_1/Europe/Berlin"). */
    private function zone(string $tzid): ?string
    {
        $tzid = trim($tzid, " \"'");
        if ($iana = WindowsZones::toIana($tzid)) {
            return $iana;
        }
        if (preg_match('~([A-Za-z_]+/[A-Za-z_\-]+(?:/[A-Za-z_\-]+)?)$~', $tzid, $m)) {
            return WindowsZones::toIana($m[1]);
        }

        return null;
    }

    /**
     * @return array{0: string, 1: array<string, string>, 2: string}
     */
    private function property(string $line): array
    {
        // NAME;PARAM=VALUE;PARAM="quoted:value":VALUE — the first colon outside quotes ends the parameters.
        $inQuote = false;
        $split = null;
        for ($i = 0, $n = strlen($line); $i < $n; $i++) {
            if ($line[$i] === '"') {
                $inQuote = ! $inQuote;
            } elseif ($line[$i] === ':' && ! $inQuote) {
                $split = $i;
                break;
            }
        }
        if ($split === null) {
            return [strtoupper($line), [], ''];
        }
        $head = explode(';', substr($line, 0, $split));
        $params = [];
        foreach (array_slice($head, 1) as $param) {
            [$k, $v] = array_pad(explode('=', $param, 2), 2, '');
            $params[strtoupper($k)] = trim($v, '"');
        }

        return [strtoupper($head[0]), $params, substr($line, $split + 1)];
    }

    /**
     * @param  array<string, list<array{params: array<string, string>, value: string}>>  $v
     */
    private function first(array $v, string $prop): ?string
    {
        return $v[$prop][0]['value'] ?? null;
    }

    private function text(string $value): string
    {
        return trim(strtr($value, ['\\n' => ' ', '\\N' => ' ', '\\,' => ',', '\;' => ';', '\\\\' => '\\']));
    }
}
