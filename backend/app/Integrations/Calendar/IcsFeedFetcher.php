<?php

namespace App\Integrations\Calendar;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Fetches a user-supplied calendar feed without letting the address reach the server's own network: HTTPS only, the
 * host must resolve to public addresses only, the connection is pinned to the checked address (no DNS rebinding),
 * redirects are followed manually and re-checked, and the body is capped.
 */
class IcsFeedFetcher
{
    public const MAX_BYTES = 5 * 1024 * 1024;

    private const MAX_REDIRECTS = 3;

    public function __construct(private HostResolver $resolver) {}

    /**
     * Normalise and validate a feed address (webcal:// becomes https://).
     */
    public function normalise(string $url): string
    {
        $url = trim($url);
        if (preg_match('~^webcals?://~i', $url)) {
            $url = 'https://'.preg_replace('~^webcals?://~i', '', $url);
        }
        $parts = parse_url($url);
        if (! $parts || strtolower($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])) {
            throw new ProviderException('Use a calendar address that starts with https:// or webcal://.');
        }
        if (isset($parts['user']) || isset($parts['pass']) || (isset($parts['port']) && (int) $parts['port'] !== 443)) {
            throw new ProviderException('Calendar addresses with a username, password or custom port are not supported.');
        }

        return $url;
    }

    /**
     * @return array{status: int, body: string, etag: ?string, last_modified: ?string}
     */
    public function fetch(string $url, ?string $etag = null, ?string $lastModified = null): array
    {
        $url = $this->normalise($url);
        for ($hop = 0; $hop <= self::MAX_REDIRECTS; $hop++) {
            $host = strtolower((string) parse_url($url, PHP_URL_HOST));
            $ip = $this->publicAddress($host);
            $response = $this->request($url, $host, $ip, $etag, $lastModified);
            if (in_array($response->status(), [301, 302, 303, 307, 308], true) && ($location = $response->header('Location'))) {
                $url = $this->normalise((string) (parse_url($location, PHP_URL_SCHEME) ? $location : 'https://'.$host.'/'.ltrim($location, '/')));

                continue;
            }

            return $this->result($response);
        }

        throw new ProviderException('The calendar address redirects too many times.');
    }

    private function request(string $url, string $host, string $ip, ?string $etag, ?string $lastModified): Response
    {
        $pin = str_contains($ip, ':') ? "[{$ip}]" : $ip;
        try {
            return Http::withHeaders(array_filter(['Accept' => 'text/calendar, text/plain;q=0.8, */*;q=0.1', 'User-Agent' => 'LifeOS-Calendar/1.0', 'If-None-Match' => $etag, 'If-Modified-Since' => $lastModified]))
                ->timeout(15)->connectTimeout(5)
                ->withOptions([
                    'allow_redirects' => false,
                    'curl' => [CURLOPT_RESOLVE => ["{$host}:443:{$pin}"]],
                    'progress' => function ($total, $downloaded) {
                        if ($total > self::MAX_BYTES || $downloaded > self::MAX_BYTES) {
                            throw new RuntimeException('feed too large');
                        }
                    },
                ])->get($url);
        } catch (ConnectionException|RuntimeException $e) {
            throw new ProviderException(str_contains($e->getMessage(), 'too large') ? 'The calendar feed is larger than 5 MB.' : 'Could not reach the calendar address.', 0, $e);
        }
    }

    /**
     * @return array{status: int, body: string, etag: ?string, last_modified: ?string}
     */
    private function result(Response $response): array
    {
        $status = $response->status();
        if ($status === 304) {
            return ['status' => 304, 'body' => '', 'etag' => $response->header('ETag') ?: null, 'last_modified' => $response->header('Last-Modified') ?: null];
        }
        if (in_array($status, [401, 403, 404, 410], true)) {
            // Secret feed links stop working when they are reset or the calendar is unshared.
            throw new ProviderAuthException("The calendar address no longer works ({$status}). It may have been reset or unshared — paste the current link to resubscribe.");
        }
        if ($status === 429 || ($status === 503 && $response->header('Retry-After'))) {
            $after = (int) $response->header('Retry-After');
            throw new RateLimitedException('The calendar server asked LifeOS to slow down.', max(30, min(3600, $after ?: 300)));
        }
        if (! $response->successful()) {
            throw new ProviderException("The calendar server returned an error ({$status}).");
        }
        $body = $response->body();
        if (strlen($body) > self::MAX_BYTES) {
            throw new ProviderException('The calendar feed is larger than 5 MB.');
        }

        return ['status' => 200, 'body' => $body, 'etag' => $response->header('ETag') ?: null, 'last_modified' => $response->header('Last-Modified') ?: null];
    }

    /**
     * The first resolved address, after checking that every address is public.
     */
    private function publicAddress(string $host): string
    {
        $literal = trim($host, '[]');
        $ips = filter_var($literal, FILTER_VALIDATE_IP) ? [$literal] : $this->resolver->resolve($host);
        if (! $ips) {
            throw new ProviderException('The calendar address could not be found. Check the link.');
        }
        foreach ($ips as $ip) {
            if (! $this->isPublic($ip)) {
                throw new ProviderException('This calendar address points to a private network and cannot be used.');
            }
        }

        return $ips[0];
    }

    private function isPublic(string $ip): bool
    {
        if (str_starts_with(strtolower($ip), '::ffff:')) {
            $ip = substr($ip, 7);
        }
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
}
