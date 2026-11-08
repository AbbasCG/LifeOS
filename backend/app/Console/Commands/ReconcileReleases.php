<?php

namespace App\Console\Commands;

use App\Services\Discovery\ReleaseService;
use Illuminate\Console\Command;

class ReconcileReleases extends Command
{
    protected $signature = 'lifeos:discovery:reconcile {--dry-run : Show what would change without writing}';

    protected $description = 'Register the releases in the running code once a healthy deploy is confirmed, and mark those a rollback removed. Does nothing unless DISCOVERY_AUTO_ACTIVATE is on and the deploy marker matches the running commit.';

    public function handle(ReleaseService $releases): int
    {
        $result = $releases->reconcile((bool) $this->option('dry-run'));
        $this->line(sprintf('%s: %s', $result['status'], $result['detail']));
        foreach (['registered', 'updated', 'absent'] as $group) {
            if ($result[$group] !== []) {
                $this->line(sprintf('  %s: %s', $group, implode(', ', $result[$group])));
            }
        }

        return self::SUCCESS;
    }
}
