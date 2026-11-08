<?php

namespace App\Console\Commands;

use App\Services\Discovery\DeployConfirmation;
use Illuminate\Console\Command;

class CheckDeployMarker extends Command
{
    protected $signature = 'lifeos:discovery:check-marker';

    protected $description = 'Read-only: report whether this account can read the deploy-success marker and whether it matches the running commit. Run it as the account that runs the scheduler.';

    public function handle(DeployConfirmation $deploy): int
    {
        $state = $deploy->inspect();
        $path = $state['marker_path'];
        $owner = is_file($path) && function_exists('posix_getpwuid') ? (posix_getpwuid((int) fileowner($path))['name'] ?? '?') : '-';
        $me = function_exists('posix_getpwuid') ? (posix_getpwuid(posix_geteuid())['name'] ?? '?') : '?';
        $this->line('Account running this command: '.$me);
        $this->line('Marker: '.$path.(is_file($path) ? sprintf(' (owner %s, mode %s)', $owner, substr(sprintf('%o', fileperms($path)), -4)) : ' (not visible)'));
        $this->line('Marker commit: '.($state['marker'] ?? '-'));
        $this->line('Running commit: '.($state['head'] ?? '-'));
        $this->line('Activation switch (DISCOVERY_AUTO_ACTIVATE): '.($state['enabled'] ? 'on' : 'off'));
        $this->line('Result: '.$state['status'].' - '.$state['detail']);
        $verifiable = in_array($state['status'], ['confirmed', 'disabled', 'not_confirmed'], true);
        if (! $verifiable) {
            $this->warn('The marker cannot be verified from here, so keep DISCOVERY_AUTO_ACTIVATE off. See docs/DISCOVERY.md.');
        }

        return $verifiable ? self::SUCCESS : self::FAILURE;
    }
}
