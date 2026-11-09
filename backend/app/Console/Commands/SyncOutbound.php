<?php

namespace App\Console\Commands;

use App\Integrations\Sync\SyncPolicy;
use App\Jobs\PushOutboundChanges;
use App\Models\CalendarAccount;
use Illuminate\Console\Command;

class SyncOutbound extends Command
{
    protected $signature = 'lifeos:sync-outbound';

    protected $description = 'Queue the updates of the copies LifeOS added, for connections whose sync direction sends changes and whose permissions allow it.';

    public function handle(SyncPolicy $policy): int
    {
        $count = 0;
        CalendarAccount::whereIn('sync_direction', [SyncPolicy::OUTBOUND, SyncPolicy::TWO_WAY])->whereNull('sync_paused_at')->where('status', '!=', 'revoked')->chunkById(200, function ($accounts) use (&$count, $policy) {
            foreach ($accounts as $account) {
                if ($policy->scheduledOutbound($account) && ($account->retry_after === null || $account->retry_after->isPast())) {
                    PushOutboundChanges::dispatch($account->id);
                    $count++;
                }
            }
        });
        $this->info("Queued {$count} outbound sync(s).");

        return self::SUCCESS;
    }
}
