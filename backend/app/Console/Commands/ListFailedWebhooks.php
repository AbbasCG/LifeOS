<?php

namespace App\Console\Commands;

use App\Models\WebhookDelivery;
use Illuminate\Console\Command;

class ListFailedWebhooks extends Command
{
    protected $signature = 'lifeos:webhooks:failed {--status=* : failed and/or retrying (default: both)} {--limit=50 : at most this many rows, newest first}';

    protected $description = 'List webhook deliveries that failed or are waiting for another attempt (never prints payloads or secrets).';

    private const STATUSES = ['failed', 'retrying'];

    public function handle(): int
    {
        $statuses = $this->option('status') ?: self::STATUSES;
        if (array_diff($statuses, self::STATUSES) !== []) {
            $this->error('--status accepts only: '.implode(', ', self::STATUSES).'.');

            return self::INVALID;
        }
        $rows = WebhookDelivery::with('endpoint:id,name,provider_key')->whereIn('status', $statuses)
            ->orderByDesc('received_at')->orderByDesc('id')->limit(max(1, min(500, (int) $this->option('limit'))))->get();
        if ($rows->isEmpty()) {
            $this->info('No failed or retrying webhook deliveries.');

            return self::SUCCESS;
        }
        $this->table(
            ['id', 'endpoint', 'provider', 'delivery id', 'status', 'attempts', 'received', 'next attempt', 'payload kept', 'last error'],
            $rows->map(fn (WebhookDelivery $d) => [
                $d->id, $d->endpoint?->name, $d->endpoint?->provider_key, $d->delivery_id, $d->status, $d->attempts,
                $d->received_at?->toIso8601String(), $d->next_attempt_at?->toIso8601String() ?? '-', $d->payload !== null || $d->size === 0 ? 'yes' : 'no',
                mb_strimwidth((string) $d->last_error, 0, 120, '…'),
            ])->all(),
        );
        $this->line('Process a failed delivery again with: php artisan lifeos:webhooks:retry <id> (or --all).');

        return self::SUCCESS;
    }
}
