<?php

namespace App\Console\Commands;

use App\Integrations\Webhooks\WebhookDeliveryQueue;
use App\Models\WebhookDelivery;
use Illuminate\Console\Command;

class RetryFailedWebhooks extends Command
{
    protected $signature = 'lifeos:webhooks:retry {ids?* : ids from lifeos:webhooks:failed} {--all : every failed or stuck delivery} {--stuck : only accepted or retrying deliveries whose job is overdue (run by the scheduler)}';

    protected $description = 'Queue failed (or stuck) webhook deliveries again. Each is processed at most once more; deliveries in any other state are skipped.';

    public function handle(WebhookDeliveryQueue $queue): int
    {
        $ids = collect($this->argument('ids'))->map(fn ($id) => (int) $id)->filter(fn (int $id) => $id > 0)->unique()->values();
        if ($ids->isEmpty() && ! $this->option('all') && ! $this->option('stuck')) {
            $this->error('Give one or more delivery ids, --all for every failed or stuck delivery, or --stuck for stuck ones only.');

            return self::INVALID;
        }
        // --stuck never touches "failed": a delivery that failed for good (an invalid payload) must not be retried on every scheduler run.
        $deliveries = $this->option('stuck')
            ? WebhookDelivery::with('endpoint')->whereIn('status', ['accepted', 'retrying'])->orderBy('id')->get()
                ->filter(fn (WebhookDelivery $d) => $queue->isStale($d))->values()
            : ($this->option('all')
            ? WebhookDelivery::with('endpoint')->whereIn('status', ['failed', 'accepted', 'retrying'])->orderBy('id')->get()
                ->filter(fn (WebhookDelivery $d) => $d->status === 'failed' || $queue->isStale($d))->values()
            : WebhookDelivery::with('endpoint')->whereIn('id', $ids)->orderBy('id')->get());
        foreach ($ids->diff($deliveries->pluck('id')) as $missing) {
            $this->warn("#{$missing}: not found (it may have been pruned).");
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
