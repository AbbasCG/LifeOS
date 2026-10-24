<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

/**
 * A read-only external calendar. Implementations must never write to the provider.
 *
 * Each upserted event: id, calendar_id, title, starts_at, ends_at (UTC), all_day, show_as, and the stable identifiers
 * ical_uid (shared by the same meeting across calendars and providers), series_id (recurring master) and original_start
 * (the occurrence's scheduled start before any move), plus the event's own timezone.
 */
interface CalendarProvider extends ConnectedProvider
{
    /**
     * Read one calendar. Without a token this is a full read of [from, to); with a token it returns only what changed
     * (and throws SyncTokenExpiredException when the token is no longer valid).
     */
    public function changes(string $accessToken, string $calendarId, ?string $syncToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): ChangeSet;
}
