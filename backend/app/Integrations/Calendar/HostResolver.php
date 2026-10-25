<?php

namespace App\Integrations\Calendar;

/**
 * DNS lookups for outbound fetches of user-supplied URLs (swappable in tests).
 */
class HostResolver
{
    /**
     * @return list<string> IPv4 and IPv6 addresses
     */
    public function resolve(string $host): array
    {
        $ips = [];
        foreach (@dns_get_record($host, DNS_A | DNS_AAAA) ?: [] as $record) {
            $ips[] = $record['ip'] ?? $record['ipv6'] ?? null;
        }
        if (! $ips) {
            $ips = @gethostbynamel($host) ?: [];
        }

        return array_values(array_unique(array_filter($ips)));
    }
}
