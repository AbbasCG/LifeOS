<?php

namespace App\Integrations\Webhooks;

use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;

/**
 * A connector's reaction to a verified webhook delivery. Handlers are registered by tagging them in a service provider
 * with the tag "integrations.webhook_handlers"; the signature has already been checked when handle() is called.
 *
 * handle() runs inside the database transaction that also records the delivery as processed, so its database writes commit together with that
 * status or not at all. Throwing makes the delivery retry later with backoff; throw PermanentWebhookException when retrying cannot help.
 * Side effects outside the database (HTTP calls, mail) are not rolled back, so they must be safe to repeat.
 */
interface WebhookHandler
{
    public function supports(string $providerKey): bool;

    public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void;
}
