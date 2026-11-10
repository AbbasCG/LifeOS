<?php

namespace App\Integrations\OAuth;

use App\Models\OauthState;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Server-side state for OAuth 2.0 authorization-code + PKCE flows (replaces keeping it in the browser session).
 *
 * begin() creates a random state and PKCE verifier bound to one user and one provider; consume() accepts a state exactly
 * once, only for that user and provider, and only before it expires. Consumption is a single atomic UPDATE, so two
 * concurrent callbacks with the same state cannot both succeed.
 */
class OAuthStateStore
{
    /**
     * @return array{state: string, verifier: string, challenge: string}
     */
    public function begin(User $user, string $provider, ?string $returnTo = null, ?int $accountId = null): array
    {
        $state = self::base64Url(random_bytes(32));
        $verifier = self::base64Url(random_bytes(48));
        OauthState::create([
            'state_hash' => hash('sha256', $state),
            'user_id' => $user->id,
            'provider' => $provider,
            'account_id' => $accountId,
            'verifier' => $verifier,
            'return_to' => self::safeReturnTo($returnTo),
            'expires_at' => now()->addSeconds((int) config('integrations.oauth_state_ttl', 600)),
        ]);

        return ['state' => $state, 'verifier' => $verifier, 'challenge' => self::challenge($verifier)];
    }

    /**
     * @return array{verifier: string, return_to: ?string, account_id: ?int}|null null when the state is unknown, expired, already used, or belongs to someone else
     */
    public function consume(string $state, User $user, string $provider): ?array
    {
        if ($state === '' || strlen($state) > 200) {
            return null;
        }
        $hash = hash('sha256', $state);
        $now = now();
        $claimed = DB::table('oauth_states')
            ->where('state_hash', $hash)->where('user_id', $user->id)->where('provider', $provider)
            ->whereNull('consumed_at')->where('expires_at', '>', $now)
            ->update(['consumed_at' => $now, 'updated_at' => $now]);
        if ($claimed !== 1) {
            return null;
        }
        $row = OauthState::where('state_hash', $hash)->first();

        return $row ? ['verifier' => $row->verifier, 'return_to' => $row->return_to, 'account_id' => $row->account_id] : null;
    }

    /**
     * Delete states that expired more than an hour ago, in chunks. A used state expires within minutes of being issued, so this also covers
     * consumed ones; filtering on expires_at alone keeps the query on its index.
     */
    public function prune(): int
    {
        $cutoff = now()->subHour();
        $deleted = 0;
        do {
            $ids = OauthState::where('expires_at', '<', $cutoff)->orderBy('id')->limit(1000)->pluck('id');
            if ($ids->isNotEmpty()) {
                $deleted += OauthState::whereIn('id', $ids)->delete();
            }
        } while ($ids->count() === 1000);

        return $deleted;
    }

    /** PKCE S256: BASE64URL(SHA256(verifier)). */
    public static function challenge(string $verifier): string
    {
        return self::base64Url(hash('sha256', $verifier, true));
    }

    /** Only same-site relative paths are kept, so a state can never carry an open redirect. */
    public static function safeReturnTo(?string $path): ?string
    {
        if ($path === null || $path === '' || ! str_starts_with($path, '/') || str_starts_with($path, '//') || str_contains($path, '\\') || preg_match('/[\x00-\x1f]/', $path) || strlen($path) > 255) {
            return null;
        }

        return $path;
    }

    private static function base64Url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }
}
