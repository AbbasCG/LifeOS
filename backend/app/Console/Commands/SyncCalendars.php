<?php

namespace App\Console\Commands;

use App\Jobs\SyncCalendarAccount;
use App\Models\CalendarAccount;
use App\Services\CalendarSyncService;
use Illuminate\Console\Command;

class SyncCalendars extends Command
{
    protected $signature = 'lifeos:sync-calendars';

    protected $description = 'Queue a read-only sync for every connected external calendar.';

    public function handle(CalendarSyncService $sync): int
    {
        $count = 0;
        // Accounts waiting out a provider Retry-After or a failure back-off are skipped until they are due again.
        CalendarAccount::where('status', '!=', 'revoked')->chunkById(200, function ($accounts) use (&$count, $sync) {
            foreach ($accounts as $account) {
                if (! $sync->due($account)) {
                    continue;
                }
                SyncCalendarAccount::dispatch($account->id);
                $count++;
            }
        });
        $this->info("Queued {$count} calendar sync(s).");

        return self::SUCCESS;
    }
}
