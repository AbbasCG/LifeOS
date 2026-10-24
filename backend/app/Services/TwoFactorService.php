<?php

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Str;

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s) and single-use recovery codes.
 * Secrets are stored encrypted by the User model; recovery codes are stored only as SHA-256 hashes.
 */
class TwoFactorService
{
    public const PERIOD = 30;

    public const DIGITS = 6;

    public const WINDOW = 1;

    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public function generateSecret(): string
    {
        return $this->base32Encode(random_bytes(20));
    }

    public function otpauthUri(User $user, string $secret): string
    {
        $issuer = config('app.name', 'LifeOS');
        $label = rawurlencode($issuer).':'.rawurlencode($user->email);

        return "otpauth://totp/{$label}?secret={$secret}&issuer=".rawurlencode($issuer).'&algorithm=SHA1&digits='.self::DIGITS.'&period='.self::PERIOD;
    }

    /**
     * RFC 4226 HOTP value for a time step.
     */
    public function code(string $secret, int $step): string
    {
        $hash = hash_hmac('sha1', pack('N2', intdiv($step, 2 ** 32), $step % (2 ** 32)), $this->base32Decode($secret), true);
        $offset = ord($hash[19]) & 0x0F;
        $value = ((ord($hash[$offset]) & 0x7F) << 24) | (ord($hash[$offset + 1]) << 16) | (ord($hash[$offset + 2]) << 8) | ord($hash[$offset + 3]);

        return str_pad((string) ($value % 10 ** self::DIGITS), self::DIGITS, '0', STR_PAD_LEFT);
    }

    /**
     * The matching time step within ±WINDOW, or null. Never accepts a step at or before $lastStep (replay protection).
     */
    public function matchStep(string $secret, string $code, ?int $lastStep = null, ?int $now = null): ?int
    {
        $code = preg_replace('/\s+/', '', $code);
        if (! preg_match('/^\d{'.self::DIGITS.'}$/', $code)) {
            return null;
        }
        $current = intdiv($now ?? now()->getTimestamp(), self::PERIOD);
        for ($step = $current - self::WINDOW; $step <= $current + self::WINDOW; $step++) {
            if (($lastStep === null || $step > $lastStep) && hash_equals($this->code($secret, $step), $code)) {
                return $step;
            }
        }

        return null;
    }

    /**
     * Verify a code for a user with confirmed 2FA and record the step so it cannot be reused.
     */
    public function verify(User $user, string $code): bool
    {
        if (! $user->two_factor_secret) {
            return false;
        }
        $step = $this->matchStep($user->two_factor_secret, $code, $user->two_factor_last_step);
        if ($step === null) {
            return false;
        }
        $user->forceFill(['two_factor_last_step' => $step])->save();

        return true;
    }

    /**
     * Generate new recovery codes. Returns the plaintext codes (shown once) and stores their hashes.
     *
     * @return list<string>
     */
    public function regenerateRecoveryCodes(User $user): array
    {
        $codes = array_map(fn () => Str::lower(Str::random(5).'-'.Str::random(5)), range(1, 8));
        $user->forceFill(['two_factor_recovery_codes' => array_map(fn ($c) => hash('sha256', $c), $codes)])->save();

        return $codes;
    }

    /**
     * Consume a recovery code if it is valid.
     */
    public function useRecoveryCode(User $user, string $code): bool
    {
        $hash = hash('sha256', Str::lower(trim($code)));
        $remaining = $user->two_factor_recovery_codes ?? [];
        foreach ($remaining as $index => $stored) {
            if (hash_equals($stored, $hash)) {
                unset($remaining[$index]);
                $user->forceFill(['two_factor_recovery_codes' => array_values($remaining)])->save();

                return true;
            }
        }

        return false;
    }

    public function base32Encode(string $bytes): string
    {
        $bits = '';
        foreach (str_split($bytes) as $char) {
            $bits .= str_pad(decbin(ord($char)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }

    public function base32Decode(string $text): string
    {
        $bits = '';
        foreach (str_split(strtoupper(rtrim($text, '='))) as $char) {
            $index = strpos(self::ALPHABET, $char);
            if ($index === false) {
                continue;
            }
            $bits .= str_pad(decbin($index), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr(bindec($byte));
            }
        }

        return $out;
    }
}
