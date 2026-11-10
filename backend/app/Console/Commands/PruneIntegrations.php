<?php

namespace App\Console\Commands;

use App\Integrations\OAuth\OAuthStateStore;
use App\Integrations\Sync\SyncRunPruner;
use App\Integrations\Webhooks\WebhookEndpointService;
use Illuminate\Console\Command;

class PruneIntegrations extends Command
{
    protected $signature = 'lifeos:integrations:prune';

    protected $description = 'Delete expired OAuth states and old webhook deliveries (including their stored payloads) and old sync runs.';

    public function handle(OAuthStateStore $states, WebhookEndpointService $webhooks, SyncRunPruner $runs): int
    {
        $this->info(sprintf('Removed %d OAuth state(s), %d webhook delivery record(s) and %d old sync run(s).', $states->prune(), $webhooks->prune(), $runs->prune()));

        return self::SUCCESS;
    }
}
