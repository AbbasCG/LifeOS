<?php

namespace App\Integrations\Webhooks;

use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;

/**
 * A connector's reaction to a verified webhook delivery. Handlers are registered by tagging them in a service provider
 * with the tag "integrations.webhook_handlers"; the signature has already been checked when handle() is called.
 */
interface WebhookHandler
{
    public function supports(string $providerKey): bool;

    public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void;
}
