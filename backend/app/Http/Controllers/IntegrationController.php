<?php

namespace App\Http\Controllers;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\ProviderException;
use App\Models\CalendarAccount;
use App\Services\AuditLogger;
use App\Services\CalendarSyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class IntegrationController extends Controller
{
    public const STATE_TTL = 600;

    public function __construct(private CalendarProviders $providers, private CalendarSyncService $sync, private AuditLogger $audit) {}

    public function index(Request $request): JsonResponse
    {
        $accounts = CalendarAccount::where('user_id', $request->user()->id)->orderBy('created_at')->get()->groupBy('provider');

        return response()->json(['providers' => collect($this->providers->all())->map(fn ($provider) => [
            'provider' => $provider->name(),
            'label' => $provider->label(),
            'configured' => $provider->isConfigured(),
            'redirect_uri' => config('services.'.($provider->name() === 'google' ? 'google_calendar' : 'microsoft_calendar').'.redirect'),
            'accounts' => $accounts->get($provider->name(), collect())->map(fn (CalendarAccount $a) => $a->summary())->values(),
        ])->values()]);
    }

    public function connect(Request $request, string $provider): JsonResponse
    {
        $driver = $this->providers->get($provider);
        abort_unless($driver !== null, 404);
        if (! $driver->isConfigured()) {
            throw ValidationException::withMessages(['provider' => ["{$driver->label()} is not configured on this server yet. An administrator must add OAuth client credentials."]]);
        }
        $state = Str::random(40);
        $verifier = Str::random(96);
        $request->session()->put("oauth.{$state}", ['provider' => $provider, 'verifier' => $verifier, 'user_id' => $request->user()->id, 'expires' => now()->getTimestamp() + self::STATE_TTL]);
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');

        return response()->json(['authorization_url' => $driver->authorizationUrl($state, $challenge)]);
    }

    /**
     * OAuth redirect target. Validates the one-time state, exchanges the code, stores encrypted tokens and runs a first sync.
     */
    public function callback(Request $request, string $provider): RedirectResponse
    {
        $driver = $this->providers->get($provider);
        abort_unless($driver !== null, 404);
        $state = (string) $request->query('state', '');
        $pending = $state !== '' ? $request->session()->pull("oauth.{$state}") : null;
        $back = fn (string $param) => redirect()->away(rtrim((string) config('app.frontend_url'), '/').'/settings/integrations?'.$param);
        if (! $pending || $pending['provider'] !== $provider || $pending['user_id'] !== $request->user()->id || $pending['expires'] < now()->getTimestamp()) {
            return $back('error=state');
        }
        if ($request->filled('error') || ! $request->filled('code')) {
            return $back('error=denied');
        }
        try {
            $tokens = $driver->exchangeCode((string) $request->query('code'), $pending['verifier']);
            $profile = $driver->account($tokens->accessToken);
        } catch (ProviderException $e) {
            report($e);

            return $back('error=exchange');
        }
        $account = CalendarAccount::firstOrNew(['user_id' => $request->user()->id, 'provider' => $provider, 'external_account_id' => $profile['id']]);
        $account->fill([
            'email' => $profile['email'],
            'display_name' => $profile['name'],
            'access_token' => $tokens->accessToken,
            'refresh_token' => $tokens->refreshToken ?? $account->refresh_token,
            'token_expires_at' => $tokens->expiresAt,
            'scopes' => $tokens->scopes,
            'status' => 'active',
            'last_error' => null,
        ])->save();
        $this->audit->log($request->user(), 'integration_connected', $request, ['provider' => $provider]);
        try {
            $this->sync->sync($account);
        } catch (ProviderException) {
            // The scheduled sync retries; the account shows the error meanwhile.
        }

        return $back('connected='.$provider);
    }

    public function sync(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        if ($account->status === 'revoked') {
            throw ValidationException::withMessages(['account' => ['Access was revoked. Reconnect this calendar.']]);
        }
        try {
            $imported = $this->sync->sync($account);
        } catch (ProviderException $e) {
            return response()->json(['message' => $e->getMessage(), 'account' => $account->fresh()->summary()], 502);
        }

        return response()->json(['imported' => $imported, 'account' => $account->fresh()->summary()]);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        $driver = $this->providers->get($account->provider);
        try {
            $driver?->revoke($account->refresh_token ?? $account->access_token);
        } catch (\Throwable $e) {
            report($e);
        }
        $provider = $account->provider;
        $account->delete();
        $this->audit->log($request->user(), 'integration_disconnected', $request, ['provider' => $provider]);

        return response()->json(['message' => 'Disconnected. Imported events were removed.']);
    }
}
