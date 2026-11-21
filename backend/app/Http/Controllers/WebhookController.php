<?php

namespace App\Http\Controllers;

use App\Integrations\Webhooks\WebhookDeliveryQueue;
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
 * timestamp -> 401 (one message for every cause), malformed delivery id or event id -> 400, then the delivery is recorded
 * exactly once and handled by a queued job.
 *
 * Replay protection. The signature covers "<timestamp>.<raw body>" but not the X-LifeOS-Delivery header, so on its own the header
 * could be changed on a captured request to have it processed again within the timestamp window. A sender therefore puts the same
 * id in its JSON body as "event_id": when present it must equal the header (the unique delivery id is then effectively signed). An
 * endpoint with require_event_id refuses bodies without it; other endpoints keep accepting them, unchanged, for existing senders.
 */
class WebhookController extends Controller
{
    private const DELIVERY_ID = '/^[A-Za-z0-9._:\-]{1,120}$/D';

    private const EVENT_ID_MESSAGE = 'The signed body must carry an "event_id" equal to the X-LifeOS-Delivery header.';

    public function receive(Request $request, string $publicId, WebhookVerifier $verifier, WebhookDeliveryQueue $queue): JsonResponse
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
        if (! preg_match(self::DELIVERY_ID, $deliveryId)) {
            return response()->json(['message' => 'A valid X-LifeOS-Delivery header is required.'], 400);
        }
        $eventId = self::signedEventId($raw);
        if ($eventId === false || ($eventId === null && $endpoint->require_event_id) || ($eventId !== null && $eventId !== $deliveryId)) {
            return response()->json(['message' => self::EVENT_ID_MESSAGE], 400);
        }
        try {
            // In its own (savepoint) transaction so a unique-key violation never poisons an enclosing PostgreSQL transaction.
            $delivery = DB::transaction(fn () => WebhookDelivery::create([
                'webhook_endpoint_id' => $endpoint->id, 'delivery_id' => $deliveryId, 'payload_sha256' => hash('sha256', $raw),
                'size' => strlen($raw), 'payload' => $raw === '' ? null : $raw, 'status' => 'accepted', 'received_at' => now(),
            ]));
        } catch (UniqueConstraintViolationException) {
            // The sender retried an event that was already accepted: acknowledge it, do not process it twice. Only a delivery that finally
            // failed is queued again, and only when the bytes are the ones recorded (a different body under the same id is never processed).
            $existing = WebhookDelivery::where('webhook_endpoint_id', $endpoint->id)->where('delivery_id', $deliveryId)->first();
            $requeued = $existing && $queue->requeue($existing, $raw);

            return response()->json(['status' => $requeued ? 'requeued' : 'duplicate'], 202);
        }
        $endpoint->forceFill(['last_delivery_at' => now()])->save();
        ProcessWebhookDelivery::dispatch($delivery->id);

        return response()->json(['status' => 'accepted'], 202);
    }

    /**
     * The top-level "event_id" of a JSON object body: the id when it is a well-formed string, false when the key is there but malformed, null
     * when the body is not a JSON object or has no event_id (an existing sender that only uses the header).
     */
    private static function signedEventId(string $raw): string|false|null
    {
        if (! str_starts_with(ltrim($raw), '{')) {
            return null;
        }
        $body = json_decode($raw, true, 64);
        if (! is_array($body) || ! array_key_exists('event_id', $body)) {
            return null;
        }

        return is_string($body['event_id']) && preg_match(self::DELIVERY_ID, $body['event_id']) ? $body['event_id'] : false;
    }
}
