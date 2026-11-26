<?php

namespace App\Console\Commands;

use App\Integrations\Webhooks\WebhookDeliveryQueue;
use App\Models\WebhookDelivery;
use Illuminate\Console\Command;

class RetryFailedWebhooks extends Command
{
    /** Rows loaded at a time by --stuck and --all. */
    private const CHUNK = 50;

    /** Deliveries handled per bulk run; the scheduler picks up the rest 15 minutes later. */
    private const MAX_BULK = 500;

    protected $signature = 'lifeos:webhooks:retry {ids?* : ids from lifeos:webhooks:failed} {--all : every failed or stuck delivery} {--stuck : only accepted or retrying deliveries whose job is overdue (run by the scheduler)}';

    protected $description = 'Queue failed (or stuck) webhook deliveries again. Each is processed at most once more; deliveries in any other state are skipped.';

    public function handle(WebhookDeliveryQueue $queue): int
    {
        $ids = collect($this->argument('ids'))->map(fn ($id) => (int) $id)->filter(fn (int $id) => $id > 0)->unique()->values();
        if ($ids->isEmpty() && ! $this->option('all') && ! $this->option('stuck')) {
            $this->error('Give one or more delivery ids, --all for every failed or stuck delivery, or --stuck for stuck ones only.');

            return self::INVALID;
        }
        // --stuck never touches "failed": a delivery that failed for good (an invalid payload) must not be retried on every scheduler run. Both
        // bulk modes filter in SQL and walk the rows in small chunks (each row carries an encrypted payload of up to 1 MB), at most
        // MAX_BULK per run; the rest waits for the next run.
        if ($this->option('stuck') || $this->option('all')) {
            $deliveries = $queue->requeueable(withFailed: ! $this->option('stuck'))
                // The scheduled run skips disabled endpoints in SQL, so their deliveries (refused until it is enabled) never use up the batch.
                ->when($this->option('stuck'), fn ($q) => $q->whereHas('endpoint', fn ($e) => $e->where('enabled', true)))
                ->with('endpoint')->lazyById(self::CHUNK)->take(self::MAX_BULK);
        } else {
            $deliveries = WebhookDelivery::with('endpoint')->whereIn('id', $ids)->orderBy('id')->get();
            foreach ($ids->diff($deliveries->pluck('id')) as $missing) {
                $this->warn("#{$missing}: not found (it may have been pruned).");
            }
        }
        $queued = 0;
        foreach ($deliveries as $delivery) {
            $reason = $queue->refusal($delivery);
            if ($reason === null && $queue->requeue($delivery)) {
                $queued++;
                $this->line("#{$delivery->id}: queued again.");
            } else {
                $this->warn("#{$delivery->id}: skipped, ".($reason ?? 'another process queued it first').'.');
            }
        }
        $this->info("Queued {$queued} delivery(ies) again.");

        return self::SUCCESS;
    }
}
