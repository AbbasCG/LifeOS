<?php

namespace App\Integrations\Webhooks;

use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use Carbon\CarbonImmutable;

/**
 * Puts a failed delivery back on the queue, exactly once. Used by `lifeos:webhooks:retry` and by the receiver when the sender redelivers a
 * failed event with the same bytes.
 *
 * Besides "failed", a delivery left "accepted" or "retrying" for longer than integrations.webhooks.stale_after_seconds past its due time is
 * also requeueable: its job was lost (the dispatch failed after the row was recorded, the queue was cleared). Queuing a second copy is safe
 * even if the first one is only late: ProcessWebhookDelivery takes the row lock and processes a delivery at most once.
 *
 * The status flip is a single conditional UPDATE on the status that was read, so two operators (or a retry and a redelivery) racing for the
 * same delivery queue it only once.
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
        // A requeued delivery is due now (next_attempt_at = now), which also makes the stale condition false for a second, racing caller.
        $flipped = WebhookDelivery::whereKey($delivery->id)->where('status', $delivery->status)
            ->when($delivery->status !== 'failed', fn ($q) => $q->whereRaw('COALESCE(next_attempt_at, received_at) < ?', [$this->staleCutoff()]))
            ->update(['status' => 'accepted', 'processed_at' => null, 'next_attempt_at' => now()]);
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
        if ($delivery->status !== 'failed' && ! $this->isStale($delivery)) {
            return in_array($delivery->status, ['accepted', 'retrying'], true)
                ? "status is {$delivery->status} and its job is not overdue yet"
                : "status is {$delivery->status}, only failed or stuck deliveries can be processed again";
        }
        if ($rawBody !== null && ! hash_equals($delivery->payload_sha256, hash('sha256', $rawBody))) {
            return 'the redelivered body differs from the recorded one';
        }
        if ($rawBody === null && $delivery->size > 0 && $delivery->payload === null) {
            return 'the payload is no longer stored';
        }

        return null;
    }

    /**
     * Whether an "accepted" or "retrying" delivery is overdue by more than the stale window (its job is presumed lost).
     */
    public function isStale(WebhookDelivery $delivery): bool
    {
        if (! in_array($delivery->status, ['accepted', 'retrying'], true)) {
            return false;
        }
        $due = $delivery->next_attempt_at ?? $delivery->received_at;

        return $due !== null && $due->lessThan($this->staleCutoff());
    }

    private function staleCutoff(): CarbonImmutable
    {
        return now()->toImmutable()->subSeconds(max(60, (int) config('integrations.webhooks.stale_after_seconds', 3600)));
    }
}
