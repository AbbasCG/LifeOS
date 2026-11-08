<?php

namespace App\Integrations\Http;

use App\Integrations\Calendar\HostResolver;
use App\Models\OutboundHostRule;

/**
 * Policy for outbound requests to addresses a person typed in (custom integrations, webhooks to other systems).
 *
 * Default deny: HTTPS only, no embedded credentials, port 443 and public addresses only. A private-network system
 * (for example an internal ERP) can be reached only through an explicit, administrator-created OutboundHostRule for
 * that exact host and port. Loopback, link-local and metadata addresses are refused even then. Redirects are not
 * followed by the returned options; a caller that follows one must run check() again for the new address.
 */
class OutboundHttpGuard
{
    public function __construct(private HostResolver $resolver) {}

    public function check(string $url): GuardedTarget
    {
        $url = trim($url);
        $parts = parse_url($url);
        if (! $parts || strtolower($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])) {
            throw new OutboundBlockedException('Only https:// addresses are allowed.');
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            throw new OutboundBlockedException('Addresses with a username or password are not allowed.');
        }
        $host = strtolower(trim($parts['host'], '[]'));
        $port = (int) ($parts['port'] ?? 443);
        $rule = OutboundHostRule::where('host', $host)->where('port', $port)->first();
        if ($port !== 443 && ! $rule) {
            throw new OutboundBlockedException('This port is not allowed.');
        }
        $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : $this->resolver->resolve($host);
        if (! $ips) {
            throw new OutboundBlockedException('The host could not be found.');
        }
        foreach ($ips as $ip) {
            if (PublicAddress::isNeverAllowed($ip)) {
                throw new OutboundBlockedException('This address can never be used.');
            }
            if (! PublicAddress::isPublic($ip) && ! ($rule && $rule->allow_private)) {
                throw new OutboundBlockedException('This address points to a private network and has not been approved by an administrator.');
            }
        }

        return new GuardedTarget($url, $host, $port, $ips[0]);
    }
}
