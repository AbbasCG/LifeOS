<?php

namespace App\Jobs;

use App\Integrations\Sync\OutboundSync;
use App\Models\CalendarAccount;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** Sends the pending updates of one connection's copies. One account per job, so a slow or failing account never holds up the others. */
class PushOutboundChanges implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public int $timeout = 120;

    public function __construct(public int $accountId) {}

    public function handle(OutboundSync $outbound): void
    {
        $account = CalendarAccount::find($this->accountId);
        if ($account) {
            $outbound->run($account);
        }
    }
}
