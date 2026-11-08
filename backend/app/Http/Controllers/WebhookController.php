<?php

namespace App\Http\Controllers;

use App\Integrations\Webhooks\WebhookVerifier;
use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Public receiver for signed webhooks (no session, no CSRF: authenticity comes from the HMAC). Order matters:
 * unknown or disabled endpoint -> 404 (identical, so endpoints cannot be probed), oversize -> 413, bad signature or
 * timestamp -> 401 (one message for every cause), then the delivery is recorded exactly once and handled by a queued job.
 */
class WebhookController extends Controller
{
    public function receive(Request $request, string $publicId, WebhookVerifier $verifier): JsonResponse
    {
        $endpoint = WebhookEndpoint::where('public_id', $publicId)->where('enabled', true)->first();
        if (! $endpoint) {
            return response()->json(['message' => 'Not found.'], 404);
        }
        $max = (int) config('integrations.webhooks.max_bytes', 1048576);
        $declared = (int) $request->header('Content-Length', 0);
        $raw = $declared > $max ? '' : $request->getContent();
        if ($declared > $max || strlen($raw) > $max) {
            return response()->json(['message' => 'Payload too large.'], 413);
        }
        if (! $verifier->verify($endpoint, $raw, $request->header('X-LifeOS-Signature'), $request->header('X-LifeOS-Timestamp'))) {
            return response()->json(['message' => 'Invalid webhook signature or timestamp.'], 401);
        }
        $deliveryId = trim((string) $request->header('X-LifeOS-Delivery'));
        if ($deliveryId === '' || strlen($deliveryId) > 120 || ! preg_match('/^[A-Za-z0-9._:\-]+$/', $deliveryId)) {
            return response()->json(['message' => 'A valid X-LifeOS-Delivery header is required.'], 400);
        }
        try {
            // In its own (savepoint) transaction so a unique-key violation never poisons an enclosing PostgreSQL transaction.
            $delivery = DB::transaction(fn () => WebhookDelivery::create([
                'webhook_endpoint_id' => $endpoint->id, 'delivery_id' => $deliveryId, 'payload_sha256' => hash('sha256', $raw),
                'size' => strlen($raw), 'payload' => $raw === '' ? null : $raw, 'status' => 'accepted', 'received_at' => now(),
            ]));
        } catch (UniqueConstraintViolationException) {
            // The sender retried an event that was already accepted: acknowledge it, do not process it twice.
            return response()->json(['status' => 'duplicate'], 202);
        }
        $endpoint->forceFill(['last_delivery_at' => now()])->save();
        ProcessWebhookDelivery::dispatch($delivery->id);

        return response()->json(['status' => 'accepted'], 202);
    }
}
