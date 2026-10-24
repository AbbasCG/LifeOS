<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

final class TokenSet
{
    public function __construct(
        public readonly string $accessToken,
        public readonly ?string $refreshToken,
        public readonly ?CarbonImmutable $expiresAt,
        public readonly ?string $scopes,
    ) {}

    /**
     * @param  array<string, mixed>  $payload
     */
    public static function fromResponse(array $payload): self
    {
        if (empty($payload['access_token'])) {
            throw new ProviderException('The provider did not return an access token.');
        }

        return new self(
            (string) $payload['access_token'],
            isset($payload['refresh_token']) ? (string) $payload['refresh_token'] : null,
            isset($payload['expires_in']) ? CarbonImmutable::now()->addSeconds((int) $payload['expires_in']) : null,
            isset($payload['scope']) ? (string) $payload['scope'] : null,
        );
    }
}
