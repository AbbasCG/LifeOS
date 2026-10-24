<?php

namespace App\Integrations\Calendar;

/**
 * An external account LifeOS can connect to with OAuth. Every implementation is read-only towards the provider.
 */
interface ConnectedProvider
{
    /** Machine name used in URLs and storage, e.g. "google", "outlook", "google_tasks". */
    public function name(): string;

    public function label(): string;

    /** "calendar" or "tasks". */
    public function category(): string;

    /** True when OAuth client credentials are configured. */
    public function isConfigured(): bool;

    /** Human-readable list of the permissions requested, for the consent explanation. */
    public function scopeSummary(): string;

    /** Environment variables an administrator sets to enable this provider. */
    public function envKeys(): array;

    public function redirectUri(): string;

    /**
     * Read scopes that must be granted (matched as substrings of the granted scope string).
     *
     * @return list<string>
     */
    public function requiredScopes(): array;

    /** True/false when the granted scopes are known, null when the provider does not report them. */
    public function scopesGranted(?string $granted): ?bool;

    public function authorizationUrl(string $state, string $codeChallenge): string;

    public function exchangeCode(string $code, string $codeVerifier): TokenSet;

    public function refresh(string $refreshToken): TokenSet;

    /**
     * @return array{id: string, email: string|null, name: string|null}
     */
    public function account(string $accessToken): array;

    /**
     * The calendars or task lists the account can read, for the user to choose from.
     *
     * @return list<array{id: string, name: string, color: string|null, primary: bool, default_included: bool}>
     */
    public function collections(string $accessToken): array;

    /** Best-effort revocation at the provider. */
    public function revoke(string $token): void;
}
