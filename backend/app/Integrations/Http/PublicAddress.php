<?php

namespace App\Integrations\Http;

/**
 * Classifies IP addresses for outbound requests to user- or administrator-supplied hosts. Shared by the calendar feed
 * fetcher and OutboundHttpGuard so there is exactly one definition of "public".
 */
final class PublicAddress
{
    /**
     * A routable public address: not private, reserved, loopback, link-local, carrier-grade NAT or unspecified.
     */
    public static function isPublic(string $ip): bool
    {
        $ip = self::unmap($ip);
        if (! filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return false;
        }
        // Carrier-grade NAT and IPv6 link-local are not covered by the flags on every PHP version.
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $long = ip2long($ip);

            return ! (($long & 0xFFC00000) === (ip2long('100.64.0.0') & 0xFFC00000));
        }

        return ! preg_match('/^(fe[89ab]|fc|fd|::1$|::$)/i', $ip);
    }

    /**
     * Addresses that must stay unreachable even for an administrator-approved host: this machine itself (PostgreSQL, PHP-FPM,
     * the deploy tooling), link-local ranges (cloud metadata services such as 169.254.169.254), multicast and the unspecified address.
     */
    public static function isNeverAllowed(string $ip): bool
    {
        $ip = self::unmap($ip);
        if (! filter_var($ip, FILTER_VALIDATE_IP)) {
            return true;
        }
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $long = ip2long($ip);
            foreach (['0.0.0.0' => 0xFF000000, '127.0.0.0' => 0xFF000000, '169.254.0.0' => 0xFFFF0000, '224.0.0.0' => 0xF0000000, '240.0.0.0' => 0xF0000000] as $net => $mask) {
                if (($long & $mask) === (ip2long($net) & $mask)) {
                    return true;
                }
            }

            return false;
        }

        return (bool) preg_match('/^(::1$|::$|fe[89ab]|ff)/i', $ip);
    }

    private static function unmap(string $ip): string
    {
        return str_starts_with(strtolower($ip), '::ffff:') ? substr($ip, 7) : $ip;
    }
}
