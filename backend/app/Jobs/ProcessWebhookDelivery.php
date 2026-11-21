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
use Illuminate\Support\Facades\DB;
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
 * `lifeos:webhooks:retry` (or a redelivery of the same bytes) can process it again. Only a redacted, shortened error is stored.
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

    public function __construct(public int $deliveryId)
    {
        $this->tries = self::maxAttempts();
    }

    public function handle(): void
    {
        try {
            DB::transaction(function () {
                $delivery = WebhookDelivery::with('endpoint')->whereKey($this->deliveryId)->lockForUpdate()->first();
                if (! $delivery || ! in_array($delivery->status, self::RUNNABLE, true)) {
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
            report($e);
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
     * A short, redacted description of a failure that is safe to keep unencrypted. A database error carries the SQL and its bound values (which
     * can be payload content), so only its class and SQLSTATE are kept.
     */
    private static function describe(?Throwable $e): string
    {
        if ($e === null) {
            return 'The queue worker stopped the job.';
        }
        if ($e instanceof QueryException) {
            return class_basename($e).': SQLSTATE '.($e->errorInfo[0] ?? $e->getCode());
        }

        return mb_substr(class_basename($e).': '.SecretRedactor::scrub($e->getMessage()), 0, 500);
    }

    /**
     * Store the outcome of a failed run outside the rolled-back transaction. Returns the delay before the next run, or null when it was final.
     */
    private function recordFailure(?Throwable $e, bool $final): ?int
    {
        $delivery = WebhookDelivery::find($this->deliveryId);
        if (! $delivery || ! in_array($delivery->status, self::RUNNABLE, true)) {
            return null;
        }
        $attempts = $delivery->attempts + 1;
        $delay = $final ? null : self::backoffAfter($this->attempts());
        $delivery->forceFill([
            'status' => $final ? 'failed' : 'retrying',
            'attempts' => min(self::MAX_COUNTER, $attempts),
            'last_error' => self::describe($e),
            'next_attempt_at' => $delay === null ? null : now()->addSeconds($delay),
            'processed_at' => $final ? now() : null,
        ])->save();

        return $delay;
    }
}
