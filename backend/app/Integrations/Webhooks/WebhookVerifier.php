<?php

namespace App\Integrations\Webhooks;

use App\Models\WebhookEndpoint;

/**
 * LifeOS webhook signature scheme (used by n8n flows and custom systems that can compute an HMAC):
 *
 *   X-LifeOS-Timestamp: <unix seconds>
 *   X-LifeOS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw request body>" with the endpoint secret>
 *   X-LifeOS-Delivery:  <unique id per event, reused when the sender retries>
 *
 * The HMAC covers the raw bytes (never re-encoded JSON), is compared in constant time, and a timestamp outside the
 * tolerance window is rejected, which together with the unique delivery id stops replays. After a secret rotation the
 * previous secret is accepted until its expiry so senders can switch without downtime.
 */
class WebhookVerifier
{
    public function verify(WebhookEndpoint $endpoint, string $rawBody, ?string $signature, ?string $timestamp): bool
    {
        if ($timestamp === null || ! preg_match('/^\d{9,11}$/', $timestamp)) {
            return false;
        }
        if (abs(time() - (int) $timestamp) > (int) config('integrations.webhooks.tolerance_seconds', 300)) {
            return false;
        }
        if ($signature === null || ! preg_match('/^sha256=([0-9a-fA-F]{64})$/', $signature, $m)) {
            return false;
        }
        $given = strtolower($m[1]);
        $secrets = [$endpoint->secret];
        if ($endpoint->previous_secret && $endpoint->previous_secret_expires_at?->isFuture()) {
            $secrets[] = $endpoint->previous_secret;
        }
        $valid = false;
        foreach ($secrets as $secret) {
            // Check every candidate without short-circuiting so timing does not reveal which one matched.
            $valid = hash_equals(hash_hmac('sha256', $timestamp.'.'.$rawBody, $secret), $given) || $valid;
        }

        return $valid;
    }

    /** The header value a sender computes (also used by tests and by outbound events later). */
    public static function sign(string $secret, int $timestamp, string $rawBody): string
    {
        return 'sha256='.hash_hmac('sha256', $timestamp.'.'.$rawBody, $secret);
    }
}
