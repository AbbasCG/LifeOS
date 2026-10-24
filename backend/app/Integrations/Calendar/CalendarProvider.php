<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

/**
 * A read-only external calendar. Implementations must never write to the provider.
 */
interface CalendarProvider
{
    /** Machine name used in URLs and storage: "google" or "outlook". */
    public function name(): string;

    public function label(): string;

    /** True when OAuth client credentials are configured. */
    public function isConfigured(): bool;

    public function authorizationUrl(string $state, string $codeChallenge): string;

    public function exchangeCode(string $code, string $codeVerifier): TokenSet;

    public function refresh(string $refreshToken): TokenSet;

    /**
     * @return array{id: string, email: string|null, name: string|null}
     */
    public function account(string $accessToken): array;

    /**
     * Busy commitments overlapping [from, to), normalized to UTC.
     *
     * @return iterable<array{id: string, calendar_id: string|null, title: string, starts_at: CarbonImmutable, ends_at: CarbonImmutable, all_day: bool, show_as: string}>
     */
    public function events(string $accessToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): iterable;

    /** Best-effort revocation at the provider. */
    public function revoke(string $token): void;
}
