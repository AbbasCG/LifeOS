<?php

namespace App\Jobs;

use App\Integrations\Calendar\ProviderException;
use App\Models\CalendarAccount;
use App\Services\CalendarSyncService;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class SyncCalendarAccount implements ShouldBeUnique, ShouldQueue
{
    use Queueable;

    public int $tries = 4;

    public int $uniqueFor = 600;

    public function __construct(public int $accountId) {}

    public function uniqueId(): string
    {
        return (string) $this->accountId;
    }

    /**
     * @return list<int>
     */
    public function backoff(): array
    {
        return [60, 300, 900];
    }

    public function handle(CalendarSyncService $sync): void
    {
        $account = CalendarAccount::find($this->accountId);
        if (! $account) {
            return;
        }
        try {
            $sync->sync($account);
        } catch (ProviderException $e) {
            // Transient: let the queue retry with backoff. The account already records the error.
            $this->release($this->backoff()[min($this->attempts() - 1, 2)]);
        }
    }
}
