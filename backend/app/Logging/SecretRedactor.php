<?php

namespace App\Logging;

/**
 * Removes credentials from text and structured data before it is logged or stored as a user-visible error.
 * Covers bearer tokens, JWTs, key=value / JSON pairs for well-known secret names and token-like URL parameters.
 */
final class SecretRedactor
{
    public const MASK = '[REDACTED]';

    /** Context/array keys whose values are always masked. */
    private const SENSITIVE_KEYS = ['access_token', 'refresh_token', 'id_token', 'token', 'client_secret', 'secret', 'code_verifier', 'verifier', 'code', 'state', 'password', 'authorization', 'api_key', 'apikey', 'x-api-key', 'private_key', 'webhook_secret', 'signature'];

    public static function scrub(string $text): string
    {
        $text = preg_replace('/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{8,}/i', '$1 '.self::MASK, $text) ?? $text;
        $text = preg_replace('/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*/', self::MASK, $text) ?? $text;
        $text = preg_replace('/([?&](?:access_token|refresh_token|id_token|token|key|api_key|client_secret|code_verifier|code|state)=)[^&\s"\']+/i', '$1'.self::MASK, $text) ?? $text;

        return preg_replace('/("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|api[_-]?key|secret|password|authorization)"?\s*[:=]\s*)("[^"]*"|\'[^\']*\'|[^\s,&}"\']+)/i', '$1"'.self::MASK.'"', $text) ?? $text;
    }

    /**
     * @param  array<array-key, mixed>  $data
     * @return array<array-key, mixed>
     */
    public static function scrubArray(array $data, int $depth = 0): array
    {
        foreach ($data as $key => $value) {
            if (is_string($key) && in_array(strtolower($key), self::SENSITIVE_KEYS, true)) {
                $data[$key] = self::MASK;
            } elseif (is_array($value) && $depth < 8) {
                $data[$key] = self::scrubArray($value, $depth + 1);
            } elseif (is_string($value)) {
                $data[$key] = self::scrub($value);
            }
        }

        return $data;
    }
}
