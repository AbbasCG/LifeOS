<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

/**
 * A read-only calendar subscription (.ics / webcal) — school timetables, sports fixtures, public holidays, or the
 * "secret address" another calendar app shares. No sign-in: the feed address itself is the credential, so it is stored
 * encrypted like a token and never returned to the browser.
 *
 * Sync token: ETag / Last-Modified plus a content hash, so unchanged feeds cost one conditional request.
 */
class IcsProvider implements CalendarProvider
{
    public const MAX_PER_USER = 20;

    public function __construct(private IcsFeedFetcher $fetcher, private IcsParser $parser) {}

    public function name(): string
    {
        return 'ics';
    }

    public function label(): string
    {
        return 'Calendar subscription (ICS)';
    }

    public function category(): string
    {
        return 'calendar';
    }

    public function isConfigured(): bool
    {
        return true;
    }

    public function scopeSummary(): string
    {
        return 'Reads the events in a calendar feed you subscribe to. No account access, nothing is ever sent back.';
    }

    public function envKeys(): array
    {
        return [];
    }

    public function redirectUri(): string
    {
        return '';
    }

    public function requiredScopes(): array
    {
        return [];
    }

    public function scopesGranted(?string $granted): ?bool
    {
        return null;
    }

    public function authorizationUrl(string $state, string $codeChallenge): string
    {
        throw new ProviderException('Calendar subscriptions do not use sign-in. Paste the feed address instead.');
    }

    public function exchangeCode(string $code, string $codeVerifier): TokenSet
    {
        throw new ProviderException('Calendar subscriptions do not use sign-in.');
    }

    public function refresh(string $refreshToken): TokenSet
    {
        throw new ProviderAuthException('Calendar subscriptions have no refresh token.');
    }

    /**
     * Validates the feed by reading it once.
     */
    public function account(string $accessToken): array
    {
        $url = $this->fetcher->normalise($accessToken);
        $feed = $this->fetcher->fetch($url);
        $parsed = $this->parser->parse($feed['body'], 'feed', CarbonImmutable::now(), CarbonImmutable::now()->addDay(), 'UTC');
        $host = (string) parse_url($url, PHP_URL_HOST);

        return ['id' => substr(hash('sha256', $url), 0, 40), 'email' => $host, 'name' => $parsed['name'] ?? $host];
    }

    public function collections(string $accessToken): array
    {
        return [['id' => 'feed', 'name' => (string) parse_url($this->fetcher->normalise($accessToken), PHP_URL_HOST), 'color' => null, 'primary' => true, 'default_included' => true]];
    }

    public function changes(string $accessToken, string $calendarId, ?string $syncToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): ChangeSet
    {
        $previous = $syncToken ? (json_decode($syncToken, true) ?: []) : [];
        $feed = $this->fetcher->fetch($accessToken, $previous['etag'] ?? null, $previous['last_modified'] ?? null);
        $hash = $feed['status'] === 200 ? hash('sha256', $feed['body']) : ($previous['hash'] ?? null);
        $token = json_encode(['etag' => $feed['etag'] ?? $previous['etag'] ?? null, 'last_modified' => $feed['last_modified'] ?? $previous['last_modified'] ?? null, 'hash' => $hash]) ?: null;
        if ($syncToken !== null && ($feed['status'] === 304 || $hash === ($previous['hash'] ?? null))) {
            // Unchanged since the last read: nothing to apply.
            return new ChangeSet([], [], $token, false);
        }
        $parsed = $this->parser->parse($feed['body'], $calendarId, $from, $to, $userTimezone);

        return new ChangeSet($parsed['events'], [], $token, true, $parsed['skipped']);
    }

    public function revoke(string $token): void
    {
        // Nothing to revoke: unsubscribing deletes the stored address and the imported events.
    }
}
