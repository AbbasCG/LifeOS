<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

/**
 * A read-only external calendar. Implementations must never write to the provider.
 */
interface CalendarProvider extends ConnectedProvider
{
    /**
     * Busy commitments overlapping [from, to), normalized to UTC. $calendarIds limits the calendars read; null keeps the
     * provider's own default set (accounts connected before calendar selection existed).
     *
     * @param  list<string>|null  $calendarIds
     * @return iterable<array{id: string, calendar_id: string|null, title: string, starts_at: CarbonImmutable, ends_at: CarbonImmutable, all_day: bool, show_as: string}>
     */
    public function events(string $accessToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone, ?array $calendarIds = null): iterable;
}
