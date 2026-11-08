<?php

namespace App\Console\Commands;

use App\Integrations\OAuth\OAuthStateStore;
use App\Integrations\Webhooks\WebhookEndpointService;
use Illuminate\Console\Command;

class PruneIntegrations extends Command
{
    protected $signature = 'lifeos:integrations:prune';

    protected $description = 'Delete expired OAuth states and old webhook deliveries (including their stored payloads).';

    public function handle(OAuthStateStore $states, WebhookEndpointService $webhooks): int
    {
        $this->info(sprintf('Removed %d OAuth state(s) and %d webhook delivery record(s).', $states->prune(), $webhooks->prune()));

        return self::SUCCESS;
    }
}
