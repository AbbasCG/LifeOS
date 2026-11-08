<?php

namespace App\Integrations\Webhooks;

use App\Models\User;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Support\Str;

class WebhookEndpointService
{
    /**
     * The secret is returned once; only its encrypted form is stored.
     *
     * @return array{endpoint: WebhookEndpoint, secret: string}
     */
    public function create(string $providerKey, ?User $owner, string $name): array
    {
        $secret = self::newSecret();
        $endpoint = WebhookEndpoint::create(['public_id' => (string) Str::uuid(), 'provider_key' => $providerKey, 'user_id' => $owner?->id, 'name' => mb_substr($name, 0, 120), 'secret' => $secret]);

        return ['endpoint' => $endpoint, 'secret' => $secret];
    }

    /**
     * New secret now; the old one keeps verifying for the overlap window. Returns the new secret (shown once).
     */
    public function rotate(WebhookEndpoint $endpoint): string
    {
        $secret = self::newSecret();
        $endpoint->forceFill([
            'previous_secret' => $endpoint->secret,
            'previous_secret_expires_at' => now()->addHours((int) config('integrations.webhooks.secret_overlap_hours', 24)),
            'secret' => $secret,
        ])->save();

        return $secret;
    }

    /** Delete deliveries (and their stored payloads) older than the retention period. */
    public function prune(): int
    {
        return WebhookDelivery::where('received_at', '<', now()->subDays((int) config('integrations.webhooks.retention_days', 7)))->delete();
    }

    private static function newSecret(): string
    {
        return 'whsec_'.rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }
}
