<?php

namespace App\Integrations\Http;

/**
 * A destination that passed OutboundHttpGuard, with the address it was checked against. Connect to that address (not to
 * a second DNS answer) so a hostile resolver cannot swap in a private address after the check.
 */
final class GuardedTarget
{
    public function __construct(public readonly string $url, public readonly string $host, public readonly int $port, public readonly string $ip) {}

    /** @return array<string, mixed> Options for Laravel's Http::withOptions() */
    public function httpOptions(): array
    {
        $pin = str_contains($this->ip, ':') ? "[{$this->ip}]" : $this->ip;

        return ['allow_redirects' => false, 'curl' => [CURLOPT_RESOLVE => ["{$this->host}:{$this->port}:{$pin}"]]];
    }
}
