<?php

namespace App\Console\Commands;

use App\Models\WebhookEndpoint;
use Illuminate\Console\Command;

class RequireWebhookEventId extends Command
{
    protected $signature = 'lifeos:webhooks:require-event-id {publicId : the endpoint public id (uuid)} {--off : accept bodies without an event_id again}';

    protected $description = 'Make a webhook endpoint refuse every delivery whose signed JSON body has no "event_id" equal to X-LifeOS-Delivery (replay protection).';

    public function handle(): int
    {
        $endpoint = WebhookEndpoint::where('public_id', (string) $this->argument('publicId'))->first();
        if (! $endpoint) {
            $this->error('No webhook endpoint has that public id.');

            return self::FAILURE;
        }
        $require = ! $this->option('off');
        $endpoint->forceFill(['require_event_id' => $require])->save();
        $this->info($require
            ? "\"{$endpoint->name}\" now refuses deliveries without a signed event_id equal to X-LifeOS-Delivery. Make sure its sender includes one."
            : "\"{$endpoint->name}\" accepts deliveries without an event_id again (a body event_id, when present, must still match).");

        return self::SUCCESS;
    }
}
