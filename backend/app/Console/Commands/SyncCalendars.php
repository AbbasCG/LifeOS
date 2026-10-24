<?php

namespace App\Console\Commands;

use App\Jobs\SyncCalendarAccount;
use App\Models\CalendarAccount;
use Illuminate\Console\Command;

class SyncCalendars extends Command
{
    protected $signature = 'lifeos:sync-calendars';

    protected $description = 'Queue a read-only sync for every connected external calendar.';

    public function handle(): int
    {
        $count = 0;
        CalendarAccount::where('status', '!=', 'revoked')->select('id')->chunkById(200, function ($accounts) use (&$count) {
            foreach ($accounts as $account) {
                SyncCalendarAccount::dispatch($account->id);
                $count++;
            }
        });
        $this->info("Queued {$count} calendar sync(s).");

        return self::SUCCESS;
    }
}
