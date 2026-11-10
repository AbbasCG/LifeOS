<?php

namespace App\Integrations\Http;

/**
 * Classifies IP addresses for outbound requests to user- or administrator-supplied hosts. Shared by the calendar feed
 * fetcher and OutboundHttpGuard so there is exactly one definition of "public".
 *
 * IPv6 addresses that embed an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo) are unwrapped with
 * inet_pton and bit masks, and the embedded IPv4 address is judged by the IPv4 rules, so none of them can be used to
 * reach a private, loopback or metadata address.
 */
final class PublicAddress
{
    /**
     * A routable public address: not private, reserved, loopback, link-local, carrier-grade NAT, site-local,
     * documentation, discard-only or unspecified, and never an address that isNeverAllowed.
     */
    public static function isPublic(string $ip): bool
    {
        if (self::isNeverAllowed($ip)) {
            return false;
        }
        $packed = self::pack($ip);
        if ($packed === null) {
            return false;
        }
        if (strlen($packed) === 4) {
            return self::isPublicV4($packed);
        }
        // Deprecated IPv4-compatible space (::/96) is never a legitimate public destination.
        if (self::prefixIs($packed, 96, str_repeat("\0", 16))) {
            return false;
        }
        foreach (self::embeddedV4($packed) as $v4) {
            if (! self::isPublicV4($v4)) {
                return false;
            }
        }
        foreach (self::NON_PUBLIC_V6 as [$net, $bits]) {
            if (self::prefixIs($packed, $bits, (string) inet_pton($net))) {
                return false;
            }
        }

        return true;
    }

    /**
     * Addresses that must stay unreachable even for an administrator-approved host: this machine itself (PostgreSQL, PHP-FPM,
     * the deploy tooling), link-local ranges (cloud metadata services such as 169.254.169.254), multicast and the unspecified address.
     * An IPv6 address embedding such an IPv4 address is covered too.
     */
    public static function isNeverAllowed(string $ip): bool
    {
        $packed = self::pack($ip);
        if ($packed === null) {
            return true;
        }
        if (strlen($packed) === 4) {
            return self::isNeverAllowedV4($packed);
        }
        foreach (self::embeddedV4($packed) as $v4) {
            if (self::isNeverAllowedV4($v4)) {
                return true;
            }
        }
        foreach ([['::', 128], ['::1', 128], ['fe80::', 10], ['ff00::', 8]] as [$net, $bits]) {
            if (self::prefixIs($packed, $bits, (string) inet_pton($net))) {
                return true;
            }
        }

        return false;
    }

    /** @var list<array{string, int}> */
    private const NON_PUBLIC_V6 = [
        ['fc00::', 7],      // unique local
        ['fe80::', 10],     // link-local
        ['fec0::', 10],     // deprecated site-local
        ['ff00::', 8],      // multicast
        ['100::', 64],      // discard-only
        ['2001:db8::', 32], // documentation
        ['3fff::', 20],     // documentation (RFC 9637)
        ['2001:2::', 48],   // benchmarking
        ['2001:10::', 28],  // deprecated ORCHID
        ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
    ];

    /**
     * Packed 4 (IPv4) or 16 (IPv6) bytes, or null when this is not an IP address literal.
     */
    private static function pack(string $ip): ?string
    {
        if (! filter_var($ip, FILTER_VALIDATE_IP)) {
            return null;
        }
        $packed = inet_pton($ip);

        return $packed === false ? null : $packed;
    }

    /**
     * IPv4 addresses (packed, 4 bytes each) carried inside an IPv6 address.
     *
     * @return list<string>
     */
    private static function embeddedV4(string $packed): array
    {
        $found = [];
        if (self::prefixIs($packed, 96, str_repeat("\0", 10)."\xff\xff".str_repeat("\0", 4))
            || self::prefixIs($packed, 96, str_repeat("\0", 16))) {
            // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96)
            $found[] = substr($packed, 12, 4);
        }
        if (self::prefixIs($packed, 96, str_repeat("\0", 8)."\xff\xff\0\0".str_repeat("\0", 4))) {
            // SIIT translated (::ffff:0:a.b.c.d)
            $found[] = substr($packed, 12, 4);
        }
        if (self::prefixIs($packed, 96, "\x00\x64\xff\x9b".str_repeat("\0", 12))) {
            // NAT64 64:ff9b::/96
            $found[] = substr($packed, 12, 4);
        }
        if (self::prefixIs($packed, 16, "\x20\x02".str_repeat("\0", 14))) {
            // 6to4 2002::/16
            $found[] = substr($packed, 2, 4);
        }
        if (self::prefixIs($packed, 32, "\x20\x01\x00\x00".str_repeat("\0", 12))) {
            // Teredo 2001::/32: the server address, and the client address stored bit-inverted
            $found[] = substr($packed, 4, 4);
            $found[] = ~substr($packed, 12, 4);
        }

        return $found;
    }

    private static function isPublicV4(string $packed): bool
    {
        $ip = (string) inet_ntop($packed);
        if (! filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return false;
        }
        if (self::isNeverAllowedV4($packed)) {
            return false;
        }

        // Carrier-grade NAT is not covered by the flags on every PHP version.
        return ! self::prefixIs($packed, 10, "\x64\x40\x00\x00");
    }

    private static function isNeverAllowedV4(string $packed): bool
    {
        foreach ([["\0\0\0\0", 8], ["\x7f\0\0\0", 8], ["\xa9\xfe\0\0", 16], ["\xe0\0\0\0", 4], ["\xf0\0\0\0", 4]] as [$net, $bits]) {
            if (self::prefixIs($packed, $bits, $net)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Whether the first $bits bits of $packed equal those of $net (byte strings of the same length class).
     */
    private static function prefixIs(string $packed, int $bits, string $net): bool
    {
        $bytes = intdiv($bits, 8);
        if (substr($packed, 0, $bytes) !== substr($net, 0, $bytes)) {
            return false;
        }
        $rest = $bits % 8;
        if ($rest === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rest)) & 0xFF;

        return (ord($packed[$bytes]) & $mask) === (ord($net[$bytes]) & $mask);
    }
}
