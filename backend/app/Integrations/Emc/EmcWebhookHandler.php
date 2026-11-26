<?php

namespace App\Integrations\Emc;

use App\Integrations\Webhooks\PermanentWebhookException;
use App\Integrations\Webhooks\WebhookHandler;
use App\Models\User;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;

/**
 * Receives verified deliveries for endpoints with provider_key "emc" (the signature, timestamp and signed event_id were checked by the
 * receiver). Refuses, without retrying, anything that cannot be applied safely: an endpoint without an owner or account key, one that does not
 * require the signed event_id, or a payload that breaks the contract. Temporary errors (database, locks) propagate and are retried.
 */
class EmcWebhookHandler implements WebhookHandler
{
    public const PROVIDER = 'emc';

    public function __construct(private EmcTicketSync $sync) {}

    public function supports(string $providerKey): bool
    {
        return $providerKey === self::PROVIDER;
    }

    public function handle(WebhookEndpoint $endpoint, WebhookDelivery $delivery): void
    {
        if (! $endpoint->user_id || ! $endpoint->account_key) {
            throw new PermanentWebhookException('This EMC endpoint has no owner or account key.');
        }
        if (! $endpoint->require_event_id) {
            throw new PermanentWebhookException('EMC endpoints must require a signed event_id.');
        }
        if ($delivery->payload === null) {
            throw new PermanentWebhookException('The delivery has no payload.');
        }
        $owner = User::find($endpoint->user_id);
        if (! $owner) {
            throw new PermanentWebhookException('The endpoint owner no longer exists.');
        }
        $event = EmcTicketEvent::fromJson($delivery->payload, $delivery->delivery_id, $owner->timezone());
        $this->sync->apply($endpoint, $event);
    }
}
