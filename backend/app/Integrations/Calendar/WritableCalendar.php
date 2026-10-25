<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

/**
 * Opt-in write access to a calendar provider. Separate from reading: it needs its own consent (write scopes), a calendar
 * the user picked, and a confirmed preview for every single change. Implementations only touch events LifeOS created.
 */
interface WritableCalendar
{
    /** The write permission, exactly as requested from the provider. */
    public function writeScope(): string;

    /** Consent URL for read + write, for the account that is already connected. */
    public function writeAuthorizationUrl(string $state, string $codeChallenge, ?string $loginHint): string;

    /** Whether the granted scope string includes the write permission (not a read-only variant of it). */
    public function writeScopeGranted(?string $granted): bool;

    /**
     * Calendars the account can add events to.
     *
     * @return list<array{id: string, name: string, primary: bool}>
     */
    public function writableCalendars(string $accessToken): array;

    /**
     * Create an event. $clientId makes the request idempotent: repeating it never creates a second copy.
     *
     * @return array{id: string, etag: ?string}
     */
    public function createEvent(string $accessToken, string $calendarId, string $clientId, string $title, CarbonImmutable $start, CarbonImmutable $end): array;

    /**
     * Change a copy LifeOS created, only if it is unchanged there since LifeOS last wrote it (etag).
     *
     * @return array{id: string, etag: ?string}
     */
    public function updateEvent(string $accessToken, string $calendarId, string $eventId, ?string $etag, string $title, CarbonImmutable $start, CarbonImmutable $end): array;

    /** Delete a copy LifeOS created, only if it is unchanged there since LifeOS last wrote it. */
    public function deleteEvent(string $accessToken, string $calendarId, string $eventId, ?string $etag): void;
}
