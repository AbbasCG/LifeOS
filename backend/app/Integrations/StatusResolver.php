<?php

namespace App\Integrations;

use App\Integrations\Manifest\ProviderManifest;
use App\Models\CalendarAccount;

/**
 * One definition of the connection state the UI shows: requires_setup, disconnected, connected, syncing, error
 * (and "planned" for providers that are not implemented yet). It reports only what the server knows; a state is never assumed.
 */
class StatusResolver
{
    /** A run still marked running after this long is treated as stuck, not as syncing. */
    private const RUNNING_MINUTES = 10;

    /**
     * @return array{state: string, detail: string}
     */
    public function forAccount(CalendarAccount $account): array
    {
        if ($account->status === 'revoked') {
            return ['state' => 'error', 'detail' => 'revoked'];
        }
        if ($account->scopes_ok === false) {
            return ['state' => 'error', 'detail' => 'scope'];
        }
        if ($account->status === 'error') {
            return ['state' => 'error', 'detail' => $account->retry_after && $account->retry_after->isFuture() ? 'waiting' : 'failed'];
        }
        $running = $account->runs()->where('status', 'running')->where('started_at', '>', now()->subMinutes(self::RUNNING_MINUTES))->exists();

        return $running ? ['state' => 'syncing', 'detail' => 'running'] : ['state' => 'connected', 'detail' => 'ok'];
    }

    /**
     * @param  list<array{state: string, detail: string}>  $accountStates
     */
    public function forProvider(ProviderManifest $manifest, bool $setupReady, array $accountStates, bool $connectionsAllowed = true): string
    {
        if (! $manifest->isAvailable()) {
            return 'planned';
        }
        if ($accountStates === []) {
            if ($manifest->requiresAdminSetup() && ! $setupReady) {
                return 'requires_setup';
            }

            // Switched off by an administrator: nobody can start a connection (accounts that exist keep the states below).
            return $connectionsAllowed ? 'disconnected' : 'disabled';
        }
        $states = array_column($accountStates, 'state');

        return in_array('error', $states, true) ? 'error' : (in_array('syncing', $states, true) ? 'syncing' : 'connected');
    }
}
