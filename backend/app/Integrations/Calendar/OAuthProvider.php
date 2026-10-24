<?php

namespace App\Integrations\Calendar;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * Shared OAuth 2.0 authorization-code + PKCE behaviour for connected providers (calendars and task services).
 */
abstract class OAuthProvider implements ConnectedProvider
{
    abstract protected function configKey(): string;

    /**
     * Whether the scopes the user actually granted include every read scope LifeOS needs. Null when the provider did not
     * report scopes. Users can untick permissions on some consent screens (e.g. Google's granular consent).
     */
    public function scopesGranted(?string $granted): ?bool
    {
        if ($granted === null || trim($granted) === '') {
            return null;
        }
        $granted = mb_strtolower($granted);

        return collect($this->requiredScopes())->every(fn (string $scope) => str_contains($granted, mb_strtolower($scope)));
    }

    /**
     * @return list<string>
     */
    abstract public function requiredScopes(): array;

    public function redirectUri(): string
    {
        return (string) ($this->config()['redirect'] ?? '');
    }

    abstract protected function tokenUrl(): string;

    /**
     * @return array<string, mixed>
     */
    protected function config(): array
    {
        return (array) config('services.'.$this->configKey(), []);
    }

    public function isConfigured(): bool
    {
        return ! empty($this->config()['client_id']) && ! empty($this->config()['client_secret']);
    }

    public function exchangeCode(string $code, string $codeVerifier): TokenSet
    {
        return TokenSet::fromResponse($this->tokenRequest([
            'grant_type' => 'authorization_code',
            'code' => $code,
            'code_verifier' => $codeVerifier,
            'redirect_uri' => $this->config()['redirect'],
        ]));
    }

    public function refresh(string $refreshToken): TokenSet
    {
        return TokenSet::fromResponse($this->tokenRequest(['grant_type' => 'refresh_token', 'refresh_token' => $refreshToken]));
    }

    /**
     * @param  array<string, string>  $params
     * @return array<string, mixed>
     */
    protected function tokenRequest(array $params): array
    {
        $response = $this->send(fn () => Http::asForm()->acceptJson()->timeout(20)->post($this->tokenUrl(), $params + [
            'client_id' => $this->config()['client_id'],
            'client_secret' => $this->config()['client_secret'],
        ]));

        return (array) $response->json();
    }

    protected function http(string $accessToken): PendingRequest
    {
        return Http::withToken($accessToken)->acceptJson()->timeout(20)->retry(2, 500, fn ($e) => $e instanceof ConnectionException, throw: false);
    }

    /**
     * Run a request and translate failures: 400 invalid_grant / 401 / 403 → ProviderAuthException, others → ProviderException.
     *
     * @param  callable(): Response  $request
     */
    protected function send(callable $request): Response
    {
        try {
            $response = $request();
        } catch (ConnectionException $e) {
            throw new ProviderException('Could not reach '.$this->label().'.', 0, $e);
        }
        if ($response->successful()) {
            return $response;
        }
        $status = $response->status();
        $error = $response->json('error.code') ?? $response->json('error') ?? '';
        $error = is_string($error) ? $error : '';
        $reasons = collect($response->json('error.errors') ?? [])->pluck('reason')->filter()->all();
        // Google reports rate limits as 403 with a reason; they must not be mistaken for revoked access.
        if ($status === 429 || ($status === 503 && $response->header('Retry-After') !== '') || array_intersect($reasons, ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']) !== []) {
            $after = (int) ($response->header('Retry-After') ?: 0);
            throw new RateLimitedException($this->label().' asked LifeOS to slow down. Sync will resume automatically.', max(30, min(3600, $after ?: 60)));
        }
        if ($status === 410 || in_array($error, ['syncStateNotFound', 'resyncRequired', 'fullSyncRequired'], true)) {
            throw new SyncTokenExpiredException($this->label().' requires a full sync.');
        }
        if ($status === 403 && array_intersect($reasons, ['insufficientPermissions', 'forbidden']) !== []) {
            throw new ProviderAuthException($this->label().' did not grant the read permission LifeOS needs. Reconnect and allow access.');
        }
        if (in_array($status, [401, 403], true) || in_array($error, ['invalid_grant', 'unauthorized_client', 'InvalidAuthenticationToken'], true)) {
            throw new ProviderAuthException($this->label().' access was revoked or has expired.');
        }

        throw new ProviderException($this->label().' returned an error ('.$status.').');
    }
}
