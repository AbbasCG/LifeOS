<?php

namespace App\Integrations\Webhooks;

use App\Jobs\ProcessWebhookDelivery;
use App\Models\WebhookDelivery;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Puts a failed delivery back on the queue, exactly once. Used by `lifeos:webhooks:retry` and by the receiver when the sender redelivers a
 * failed event with the same bytes.
 *
 * Besides "failed", a delivery left "accepted" or "retrying" for longer than integrations.webhooks.stale_after_seconds past its due time is
 * also requeueable: its job was lost (the dispatch failed after the row was recorded, the queue was cleared). Queuing a new job is safe
 * even if the first one is only late: the new job carries the incremented generation, and the late one then neither runs the handlers nor
 * records a failure.
 *
 * The status flip is a single conditional UPDATE on the status that was read, so two operators (or a retry and a redelivery) racing for the
 * same delivery queue it only once. It also increments processing_generation, so only the newly queued job may change the delivery.
 */
class WebhookDeliveryQueue
{
    /** The only statuses that can be queued again; "processed" and "ignored" are final. */
    private const REQUEUEABLE = ['failed', 'accepted', 'retrying'];

    /**
     * @param  string|null  $rawBody  the bytes of a verified redelivery (same sha256 as the stored payload), used when the payload is gone
     * @return bool whether this call queued the delivery again
     */
    public function requeue(WebhookDelivery $delivery, ?string $rawBody = null): bool
    {
        if ($this->refusal($delivery, $rawBody) !== null) {
            return false;
        }
        $generation = (int) ($delivery->processing_generation ?? 0);   // a model fresh from create() has only the database default (0)

        // One transaction for the flip, the payload restore and the dispatch: if the dispatch throws (queue unreachable), nothing is changed, so
        // the delivery stays requeueable (a redelivery is answered "requeued" again, not "duplicate").
        //  - Database queue on the default connection: the job row is part of this transaction, so flip and job commit or roll back together.
        //  - Redis or any other queue: the push is NOT rolled back with PostgreSQL. If this transaction rolls back after a successful push, the
        //    job carries a generation the row never got and does nothing when it runs. A worker that picks it up before the commit waits on
        //    the row lock this UPDATE holds, then sees the committed generation.
        //  - The job is lost after the commit (worker or queue gone): the delivery is "stuck" and the scheduled `lifeos:webhooks:retry --stuck`
        //    queues it again under the next generation.
        return DB::transaction(function () use ($delivery, $rawBody, $generation): bool {
            // A requeued delivery is due now (next_attempt_at = now), which also makes the stale condition false for a second, racing caller.
            // The condition also covers the generation that was read: if anything queued it again in between, this call does nothing.
            $flipped = WebhookDelivery::whereKey($delivery->id)->where('status', $delivery->status)->whereIn('status', self::REQUEUEABLE)
                ->where('processing_generation', $generation)
                ->when($delivery->status !== 'failed', fn ($q) => $q->whereRaw('COALESCE(next_attempt_at, received_at) < ?', [$this->staleCutoff()]))
                ->update(['status' => 'accepted', 'processed_at' => null, 'next_attempt_at' => now(), 'processing_generation' => DB::raw('processing_generation + 1')]);
            if ($flipped !== 1) {
                return false;
            }
            $fresh = WebhookDelivery::find($delivery->id);
            if ($fresh && $fresh->payload === null && $rawBody !== null && $rawBody !== '') {
                // Only for a verified redelivery whose hash matched the recorded one, so the stored bytes are the bytes that were first accepted.
                $fresh->forceFill(['payload' => $rawBody])->save();
            }
            // Only a job of the new generation may change the delivery; a late copy of an earlier job (the lost one, or a slow one) does nothing.
            dispatch(new ProcessWebhookDelivery($delivery->id, $generation + 1));

            return true;
        });
    }

    /**
     * Why a delivery cannot be queued again, or null when it can.
     */
    public function refusal(WebhookDelivery $delivery, ?string $rawBody = null): ?string
    {
        if (! $delivery->endpoint?->enabled) {
            // Its job would only mark it failed again; it can be processed once the endpoint is enabled.
            return 'the endpoint is disabled';
        }
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

    /**
     * Deliveries that can be queued again, filtered in SQL (status is indexed), so a caller can walk them in chunks instead of loading every
     * accepted or retrying row (and its encrypted payload) into memory. With $withFailed, "failed" deliveries are included too.
     *
     * @return Builder<WebhookDelivery>
     */
    public function requeueable(bool $withFailed = false): Builder
    {
        $cutoff = $this->staleCutoff();

        return WebhookDelivery::query()->where(function (Builder $q) use ($cutoff, $withFailed) {
            $q->where(fn (Builder $stuck) => $stuck->whereIn('status', ['accepted', 'retrying'])
                ->whereRaw('COALESCE(next_attempt_at, received_at) < ?', [$cutoff]));
            if ($withFailed) {
                $q->orWhere('status', 'failed');
            }
        });
    }

    private function staleCutoff(): CarbonImmutable
    {
        return now()->toImmutable()->subSeconds(max(60, (int) config('integrations.webhooks.stale_after_seconds', 3600)));
    }
}
