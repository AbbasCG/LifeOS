<?php

namespace App\Jobs;

use App\Integrations\Webhooks\WebhookHandler;
use App\Models\WebhookDelivery;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Throwable;

/**
 * Hands a verified webhook delivery to the connector that owns the endpoint. A delivery nobody handles is marked
 * "ignored" (it is still recorded, so a redelivery stays idempotent). The payload is dropped once handled.
 */
class ProcessWebhookDelivery implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;

    public function __construct(public int $deliveryId) {}

    public function handle(): void
    {
        $delivery = WebhookDelivery::with('endpoint')->find($this->deliveryId);
        if (! $delivery || $delivery->status !== 'accepted') {
            return;
        }
        $handled = false;
        try {
            foreach (app()->tagged('integrations.webhook_handlers') as $handler) {
                /** @var WebhookHandler $handler */
                if ($handler->supports($delivery->endpoint->provider_key)) {
                    $handler->handle($delivery->endpoint, $delivery);
                    $handled = true;
                }
            }
        } catch (Throwable $e) {
            $delivery->forceFill(['status' => 'failed', 'processed_at' => now()])->save();
            report($e);

            return;
        }
        $delivery->forceFill(['status' => $handled ? 'processed' : 'ignored', 'processed_at' => now(), 'payload' => null])->save();
    }
}
