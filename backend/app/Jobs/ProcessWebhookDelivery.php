<?php

namespace App\Jobs;

use App\Integrations\Webhooks\PermanentWebhookException;
use App\Integrations\Webhooks\WebhookHandler;
use App\Logging\SecretRedactor;
use App\Models\WebhookDelivery;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Queue\Jobs\SyncJob;
use Illuminate\Queue\MaxAttemptsExceededException;
use Illuminate\Queue\TimeoutExceededException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Hands a verified webhook delivery to the connector that owns the endpoint. A delivery nobody handles is marked "ignored" (it is still
 * recorded, so a redelivery stays idempotent). The payload is dropped once handled.
 *
 * Exactly once: the handlers run inside one transaction that holds the delivery row (SELECT ... FOR UPDATE) and also writes the final status,
 * so a second copy of this job waits and then sees "processed", and a failing handler leaves nothing half-written behind.
 *
 * Retries: a handler that throws is treated as a temporary failure. The delivery becomes "retrying" and the job is released with the delays in
 * integrations.webhooks.backoff_seconds, up to integrations.webhooks.max_attempts runs. After the last run, or at once for a
 * PermanentWebhookException or on the synchronous queue (which cannot delay), it is "failed": its encrypted payload is kept so
 * `lifeos:webhooks:retry` (or a redelivery of the same bytes) can process it again. Only a description without payload content is stored
 * and logged (see describe()); the exception itself is never reported.
 *
 * Generations: each requeue increments webhook_deliveries.processing_generation and queues a job carrying the new value. A job (with its
 * releases and its failed() hook) only touches the row while the generations match, so a late job from an earlier attempt does nothing.
 */
class ProcessWebhookDelivery implements ShouldQueue
{
    use Queueable;

    /** Statuses a run may pick up; every other status is final for this job. */
    public const RUNNABLE = ['accepted', 'retrying'];

    /** webhook_deliveries.attempts is a smallint on PostgreSQL. */
    private const MAX_COUNTER = 32767;

    /** Runs allowed for this job (read by the worker, so a worker started with --tries=1 still retries). */
    public int $tries;

    /**
     * The delivery's processing_generation when this job was queued. Declared with a default so a job serialized before the column existed
     * unserializes as generation 0, which every existing row has.
     */
    public int $generation = 0;

    public function __construct(public int $deliveryId, int $generation = 0)
    {
        $this->generation = $generation;
        $this->tries = self::maxAttempts();
    }

    public function handle(): void
    {
        try {
            DB::transaction(function () {
                $delivery = WebhookDelivery::with('endpoint')->whereKey($this->deliveryId)->lockForUpdate()->first();
                if (! $delivery || ! in_array($delivery->status, self::RUNNABLE, true) || $delivery->processing_generation !== $this->generation) {
                    // Finished, or queued again since this job was dispatched: the newer job owns the delivery now.
                    return;
                }
                if (! $delivery->endpoint?->enabled) {
                    // Disabling an endpoint (e.g. after a leaked secret) also stops what it had already accepted. The payload is kept, so
                    // lifeos:webhooks:retry can process it once the endpoint is enabled again.
                    $delivery->forceFill(['status' => 'failed', 'processed_at' => now(), 'next_attempt_at' => null, 'last_error' => 'The endpoint is disabled.'])->save();

                    return;
                }
                $handled = false;
                foreach (app()->tagged('integrations.webhook_handlers') as $handler) {
                    /** @var WebhookHandler $handler */
                    if ($handler->supports($delivery->endpoint->provider_key)) {
                        $handler->handle($delivery->endpoint, $delivery);
                        $handled = true;
                    }
                }
                $delivery->forceFill([
                    'status' => $handled ? 'processed' : 'ignored', 'processed_at' => now(), 'payload' => null,
                    'attempts' => min(self::MAX_COUNTER, $delivery->attempts + 1), 'last_error' => null, 'next_attempt_at' => null,
                ])->save();
            });
        } catch (Throwable $e) {
            // Not report($e): an exception from a handler can carry ticket content, URLs or, in a QueryException, the SQL and its bound values.
            Log::warning('Webhook delivery run failed.', ['delivery_id' => $this->deliveryId, 'generation' => $this->generation, 'error' => self::describe($e)]);
            $final = $e instanceof PermanentWebhookException || $this->job === null || $this->job instanceof SyncJob || $this->attempts() >= $this->tries;
            $delay = $this->recordFailure($e, $final);
            if ($delay !== null) {
                $this->release($delay);
            }
        }
    }

    /**
     * The worker gave up on the job without handle() finishing (timeout, crash, attempts exhausted): never leave the delivery looking queued.
     */
    public function failed(?Throwable $e): void
    {
        $this->recordFailure($e, true);
    }

    /**
     * Seconds to wait before run number $attempt + 1 (the last configured delay repeats).
     */
    public static function backoffAfter(int $attempt): int
    {
        $delays = array_values(array_filter((array) config('integrations.webhooks.backoff_seconds', [30, 120, 600, 1800]), 'is_numeric'));
        if ($delays === []) {
            return 60;
        }

        return max(1, (int) $delays[min(max(0, $attempt - 1), count($delays) - 1)]);
    }

    public static function maxAttempts(): int
    {
        return max(1, (int) config('integrations.webhooks.max_attempts', 5));
    }

    /**
     * A short description of a failure that is safe to log and to keep unencrypted. Only messages LifeOS or the queue worker wrote themselves
     * are kept (and still redacted); any other exception can carry payload content (a ticket title, a URL, a secret), so only its class is
     * kept. A database error carries the SQL and its bound values, so only its class and SQLSTATE are kept.
     */
    private static function describe(?Throwable $e): string
    {
        if ($e === null) {
            return 'The queue worker stopped the job.';
        }
        if ($e instanceof QueryException) {
            return class_basename($e).': SQLSTATE '.($e->errorInfo[0] ?? $e->getCode());
        }
        if ($e instanceof PermanentWebhookException || $e instanceof MaxAttemptsExceededException || $e instanceof TimeoutExceededException) {
            return mb_substr(class_basename($e).': '.SecretRedactor::scrub($e->getMessage()), 0, 500);
        }

        return class_basename($e);
    }

    /**
     * Store the outcome of a failed run outside the rolled-back transaction. Returns the delay before the next run, or null when it was final
     * or when nothing was written.
     *
     * One conditional UPDATE, never read-then-save: the row changes only while it is still runnable. If another copy of the job is processing
     * it right now, PostgreSQL makes this UPDATE wait for that row lock and then re-checks the condition on the committed row, so a delivery
     * that became "processed" (or "ignored", or "failed") meanwhile is left as it is and this run is not released again. A job from an
     * earlier generation (the delivery was queued again since) never writes either, failed() included.
     */
    private function recordFailure(?Throwable $e, bool $final): ?int
    {
        $delay = $final ? null : self::backoffAfter($this->attempts());
        $written = WebhookDelivery::query()->whereKey($this->deliveryId)->whereIn('status', self::RUNNABLE)
            ->where('processing_generation', $this->generation)->update([
                'status' => $final ? 'failed' : 'retrying',
                'attempts' => DB::raw('CASE WHEN attempts >= '.self::MAX_COUNTER.' THEN '.self::MAX_COUNTER.' ELSE attempts + 1 END'),
                'last_error' => self::describe($e),
                'next_attempt_at' => $delay === null ? null : now()->addSeconds($delay),
                'processed_at' => $final ? now() : null,
            ]);

        return $written === 1 ? $delay : null;
    }
}
