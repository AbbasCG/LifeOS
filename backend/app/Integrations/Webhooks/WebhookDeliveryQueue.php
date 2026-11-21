<?php

namespace App\Integrations\Webhooks;

use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;

/**
 * Puts a failed delivery back on the queue, exactly once. Used by `lifeos:webhooks:retry` and by the receiver when the sender redelivers a
 * failed event with the same bytes.
 *
 * The status flip "failed -> accepted" is a single conditional UPDATE, so two operators (or a retry and a redelivery) racing for the same
 * delivery queue it only once; ProcessWebhookDelivery then takes the row lock and processes it at most once more.
 */
class WebhookDeliveryQueue
{
    /**
     * @param  string|null  $rawBody  the bytes of a verified redelivery (same sha256 as the stored payload), used when the payload is gone
     * @return bool whether this call queued the delivery again
     */
    public function requeue(WebhookDelivery $delivery, ?string $rawBody = null): bool
    {
        if ($this->refusal($delivery, $rawBody) !== null) {
            return false;
        }
        $flipped = WebhookDelivery::whereKey($delivery->id)->where('status', 'failed')
            ->update(['status' => 'accepted', 'processed_at' => null, 'next_attempt_at' => null]);
        if ($flipped !== 1) {
            return false;
        }
        $fresh = WebhookDelivery::find($delivery->id);
        if ($fresh && $fresh->payload === null && $rawBody !== null && $rawBody !== '') {
            // Only for a verified redelivery whose hash matched the recorded one, so the stored bytes are the bytes that were first accepted.
            $fresh->forceFill(['payload' => $rawBody])->save();
        }
        ProcessWebhookDelivery::dispatch($delivery->id);

        return true;
    }

    /**
     * Why a delivery cannot be queued again, or null when it can.
     */
    public function refusal(WebhookDelivery $delivery, ?string $rawBody = null): ?string
    {
        if ($delivery->status !== 'failed') {
            return "status is {$delivery->status}, only failed deliveries can be processed again";
        }
        if ($rawBody !== null && ! hash_equals($delivery->payload_sha256, hash('sha256', $rawBody))) {
            return 'the redelivered body differs from the recorded one';
        }
        if ($rawBody === null && $delivery->size > 0 && $delivery->payload === null) {
            return 'the payload is no longer stored';
        }

        return null;
    }
}
