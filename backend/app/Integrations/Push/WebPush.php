<?php

namespace App\Integrations\Push;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Standards-based Web Push using PHP's OpenSSL extension only:
 * VAPID authentication (RFC 8292, ES256 JWT) and message encryption with aes128gcm (RFC 8291 / RFC 8188).
 */
class WebPush
{
    /** DER prefix of a P-256 SubjectPublicKeyInfo; followed by the 65-byte uncompressed point. */
    private const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

    public const RECORD_SIZE = 4096;

    public function isConfigured(): bool
    {
        return filled(config('services.webpush.public_key')) && filled(config('services.webpush.private_key')) && filled(config('services.webpush.subject'));
    }

    public function publicKey(): ?string
    {
        return $this->isConfigured() ? (string) config('services.webpush.public_key') : null;
    }

    /**
     * Push service hosts we are willing to contact (prevents using subscriptions to reach arbitrary URLs).
     */
    public static function allowedEndpoint(string $endpoint): bool
    {
        $parts = parse_url($endpoint);
        if (($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])) {
            return false;
        }
        $host = strtolower($parts['host']);
        foreach ((array) config('services.webpush.allowed_hosts') as $allowed) {
            $allowed = strtolower(trim($allowed));
            if ($allowed !== '' && ($host === $allowed || str_ends_with($host, '.'.$allowed))) {
                return true;
            }
        }

        return false;
    }

    /**
     * Send one encrypted message. Returns the HTTP status from the push service.
     *
     * @throws PushException on network failure
     */
    public function send(string $endpoint, string $userPublicKey, string $userAuth, string $payload, int $ttl = 86400): int
    {
        if (! $this->isConfigured()) {
            throw new PushException('Web Push is not configured on this server.');
        }
        if (! self::allowedEndpoint($endpoint)) {
            throw new PushException('This push service is not allowed.');
        }
        $body = $this->encrypt($payload, self::base64UrlDecode($userPublicKey), self::base64UrlDecode($userAuth));
        $origin = parse_url($endpoint, PHP_URL_SCHEME).'://'.parse_url($endpoint, PHP_URL_HOST);
        $jwt = $this->vapidToken($origin, now()->getTimestamp() + 12 * 3600);
        try {
            $response = Http::withHeaders([
                'Authorization' => 'vapid t='.$jwt.', k='.config('services.webpush.public_key'),
                'Content-Encoding' => 'aes128gcm',
                'TTL' => (string) $ttl,
                'Urgency' => 'normal',
            ])->withBody($body, 'application/octet-stream')->timeout(15)->post($endpoint);
        } catch (ConnectionException $e) {
            throw new PushException('The push service could not be reached.', 0, $e);
        }

        return $response->status();
    }

    /**
     * RFC 8291 encryption. $salt and $localKey can be injected for deterministic tests.
     */
    public function encrypt(string $payload, string $userPublicKey, string $userAuth, ?string $salt = null, ?\OpenSSLAsymmetricKey $localKey = null): string
    {
        if (strlen($userPublicKey) !== 65 || $userPublicKey[0] !== "\x04" || strlen($userAuth) < 16) {
            throw new PushException('Invalid subscription keys.');
        }
        if (strlen($payload) > self::RECORD_SIZE - 16 - 1 - 86) {
            throw new PushException('Payload too large.');
        }
        $localKey ??= openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $details = openssl_pkey_get_details($localKey);
        $localPublic = "\x04".str_pad($details['ec']['x'], 32, "\0", STR_PAD_LEFT).str_pad($details['ec']['y'], 32, "\0", STR_PAD_LEFT);
        $shared = openssl_pkey_derive(self::publicKeyFromPoint($userPublicKey), $localKey, 32);
        if ($shared === false) {
            throw new PushException('Key agreement failed.');
        }
        $salt ??= random_bytes(16);

        $ikm = hash_hkdf('sha256', $shared, 32, "WebPush: info\0".$userPublicKey.$localPublic, $userAuth);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
        $tag = '';
        $cipher = openssl_encrypt($payload."\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);

        return $salt.pack('N', self::RECORD_SIZE).chr(65).$localPublic.$cipher.$tag;
    }

    /**
     * ES256-signed VAPID JWT.
     */
    public function vapidToken(string $audience, int $expires): string
    {
        $header = self::base64UrlEncode(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
        $claims = self::base64UrlEncode(json_encode(['aud' => $audience, 'exp' => $expires, 'sub' => config('services.webpush.subject')]));
        $key = self::privateKey(self::base64UrlDecode((string) config('services.webpush.private_key')), self::base64UrlDecode((string) config('services.webpush.public_key')));
        if (! openssl_sign("{$header}.{$claims}", $der, $key, OPENSSL_ALGO_SHA256)) {
            throw new PushException('Could not sign the VAPID token.');
        }

        return "{$header}.{$claims}.".self::base64UrlEncode(self::derToRaw($der));
    }

    /**
     * Generate a VAPID key pair as base64url strings (public: 65-byte point, private: 32-byte scalar).
     *
     * @return array{public_key: string, private_key: string}
     */
    public static function generateKeys(): array
    {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $ec = openssl_pkey_get_details($key)['ec'];

        return [
            'public_key' => self::base64UrlEncode("\x04".str_pad($ec['x'], 32, "\0", STR_PAD_LEFT).str_pad($ec['y'], 32, "\0", STR_PAD_LEFT)),
            'private_key' => self::base64UrlEncode(str_pad($ec['d'], 32, "\0", STR_PAD_LEFT)),
        ];
    }

    public static function publicKeyFromPoint(string $point): \OpenSSLAsymmetricKey
    {
        $pem = "-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode(hex2bin(self::SPKI_PREFIX).$point), 64, "\n").'-----END PUBLIC KEY-----';
        $key = openssl_pkey_get_public($pem);
        if ($key === false) {
            throw new PushException('Invalid public key.');
        }

        return $key;
    }

    /**
     * SEC1 ECPrivateKey (RFC 5915) for P-256 built from the raw scalar and public point.
     */
    public static function privateKey(string $d, string $point): \OpenSSLAsymmetricKey
    {
        if (strlen($d) !== 32 || strlen($point) !== 65) {
            throw new PushException('Invalid VAPID key pair.');
        }
        $der = hex2bin('30770201010420').$d.hex2bin('a00a06082a8648ce3d030107a144034200').$point;
        $key = openssl_pkey_get_private("-----BEGIN EC PRIVATE KEY-----\n".chunk_split(base64_encode($der), 64, "\n").'-----END EC PRIVATE KEY-----');
        if ($key === false) {
            throw new PushException('Invalid VAPID private key.');
        }

        return $key;
    }

    /**
     * Convert an ASN.1 DER ECDSA signature to the 64-byte r||s form JWS requires.
     */
    public static function derToRaw(string $der): string
    {
        $offset = 2 + (ord($der[1]) & 0x80 ? ord($der[1]) & 0x7F : 0);
        $parts = [];
        for ($i = 0; $i < 2; $i++) {
            if (ord($der[$offset]) !== 0x02) {
                throw new RuntimeException('Malformed signature.');
            }
            $length = ord($der[$offset + 1]);
            $parts[] = str_pad(ltrim(substr($der, $offset + 2, $length), "\0"), 32, "\0", STR_PAD_LEFT);
            $offset += 2 + $length;
        }

        return $parts[0].$parts[1];
    }

    public static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    public static function base64UrlDecode(string $data): string
    {
        return (string) base64_decode(strtr($data, '-_', '+/').str_repeat('=', (4 - strlen($data) % 4) % 4), true);
    }
}
