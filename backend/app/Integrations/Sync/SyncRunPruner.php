<?php

namespace App\Integrations\Sync;

use App\Models\SyncRun;

/**
 * Keeps sync_runs bounded (a connected account adds about 96 rows a day). A run is deleted only when it is older than
 * integrations.sync_run_retention_days AND it is not among the newest KEEP_NEWEST runs of its account, so a quiet account always keeps its
 * recent history. Deletes in chunks, so no single statement or lock is large; running it twice changes nothing the second time.
 */
class SyncRunPruner
{
    public const KEEP_NEWEST = 20;

    public const CHUNK = 1000;

    public function prune(): int
    {
        $cutoff = now()->subDays(max(1, (int) config('integrations.sync_run_retention_days', 30)));
        $deleted = 0;
        $accounts = SyncRun::query()->where('started_at', '<', $cutoff)->distinct()->pluck('calendar_account_id');
        foreach ($accounts as $accountId) {
            // Everything with an id at or above this one is among the newest runs of the account and stays.
            $floor = SyncRun::query()->where('calendar_account_id', $accountId)->orderByDesc('id')->offset(self::KEEP_NEWEST - 1)->limit(1)->value('id');
            if ($floor === null) {
                continue;
            }
            do {
                $ids = SyncRun::query()->where('calendar_account_id', $accountId)->where('started_at', '<', $cutoff)->where('id', '<', $floor)->orderBy('id')->limit(self::CHUNK)->pluck('id');
                if ($ids->isNotEmpty()) {
                    $deleted += SyncRun::query()->whereIn('id', $ids)->delete();
                }
            } while ($ids->count() === self::CHUNK);
        }

        return $deleted;
    }
}
