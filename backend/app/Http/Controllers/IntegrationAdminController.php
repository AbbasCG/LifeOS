<?php

namespace App\Http\Controllers;

use App\Http\Requests\SaveAppCredentialsRequest;
use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Manifest\ManifestRegistry;
use App\Integrations\Vault\CredentialVault;
use App\Models\AuditLog;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Administrator-only management of application-wide OAuth client credentials. Secrets are write-only: they are accepted
 * here, stored encrypted, and never returned. Access rules (administrator, two-factor, recent password confirmation) are
 * enforced by the route middleware; every change is audited.
 */
class IntegrationAdminController extends Controller
{
    /** The audit entries the provider configuration screen lists (ids and flags only: the entries never hold a secret or a client id). */
    private const AUDITED = ['integration_credentials_set', 'integration_credentials_removed', 'integration_provider_enabled', 'integration_provider_disabled', 'integration_config_tested'];

    public function __construct(private ManifestRegistry $manifests, private CredentialVault $vault, private AuditLogger $audit, private CalendarProviders $providers) {}

    public function index(Request $request): JsonResponse
    {
        $data = [];
        foreach ($this->manifests->all() as $manifest) {
            if ($manifest->isAvailable() && $manifest->requiresAdminSetup()) {
                $public = $manifest->toPublic();
                $data[] = ['name' => $public['name'], 'docs_url' => $public['docs_url'], 'scopes' => $public['scopes']] + $this->vault->status($manifest->id());
            }
        }

        return response()->json(['data' => $data]);
    }

    public function update(SaveAppCredentialsRequest $request, string $provider): JsonResponse
    {
        $provider = $request->provider();
        $this->vault->store($provider, (string) $request->input('client_id'), $request->input('client_secret'), $request->input('redirect_uri'), $request->user());
        // The audit entry names the provider and whether the secret changed - never the secret or the client id.
        $this->audit->log($request->user(), 'integration_credentials_set', $request, ['provider' => $provider, 'secret_changed' => $request->filled('client_secret')]);

        return response()->json(['data' => $this->vault->status($provider)]);
    }

    public function destroy(Request $request, string $provider): JsonResponse
    {
        $manifest = $this->manifests->find($provider);
        abort_unless($manifest && $manifest->isAvailable() && $manifest->requiresAdminSetup(), 404);
        $removed = $this->vault->forget($provider);
        if ($removed) {
            $this->audit->log($request->user(), 'integration_credentials_removed', $request, ['provider' => $provider]);
        }

        return response()->json(['data' => $this->vault->status($provider)]);
    }

    /** Switches NEW connections to a provider on or off. Accounts that are already connected keep working; nothing is deleted. */
    public function enabled(Request $request, string $provider): JsonResponse
    {
        $this->setupProvider($provider);
        $data = $request->validate(['enabled' => ['required', 'boolean']]);
        if ($this->vault->setConnectionsAllowed($provider, (bool) $data['enabled'], $request->user())) {
            $this->audit->log($request->user(), $data['enabled'] ? 'integration_provider_enabled' : 'integration_provider_disabled', $request, ['provider' => $provider]);
        }

        return response()->json(['data' => $this->vault->status($provider)]);
    }

    /**
     * Checks the saved configuration without contacting the provider (no secret is ever sent anywhere by this): whether there is a client id and a secret that
     * can be read with the current key, whether the redirect address is the one this site expects, and whether a sign-in address can be built from it.
     * It cannot prove that the provider accepts the client; only a real sign-in does that.
     */
    public function test(Request $request, string $provider): JsonResponse
    {
        $this->setupProvider($provider);
        $driver = $this->providers->get($provider);
        $status = $this->vault->status($provider);
        $configured = $status['configured'];
        $url = $configured && $driver ? parse_url($driver->authorizationUrl('test', 'test')) : false;
        parse_str(is_array($url) ? ($url['query'] ?? '') : '', $query);
        $checks = [
            ['id' => 'client_id', 'ok' => $configured],
            ['id' => 'secret_readable', 'ok' => $configured && $this->vault->secretReadable($provider)],
            ['id' => 'redirect_matches', 'ok' => $configured && $driver !== null && hash_equals($status['suggested_redirect_uri'], $driver->redirectUri())],
            ['id' => 'sign_in_address', 'ok' => is_array($url) && ($url['scheme'] ?? '') === 'https' && ($query['redirect_uri'] ?? null) === ($driver?->redirectUri()) && filled($query['client_id'] ?? null)],
            ['id' => 'connections_allowed', 'ok' => $status['connections_allowed']],
        ];
        $this->audit->log($request->user(), 'integration_config_tested', $request, ['provider' => $provider, 'ok' => ! in_array(false, array_column($checks, 'ok'), true)]);

        return response()->json(['data' => ['provider' => $provider, 'ok' => ! in_array(false, array_column($checks, 'ok'), true), 'checks' => $checks, 'contacted_provider' => false]]);
    }

    /** The latest changes to provider configuration: who, what, which provider, when. Never a secret, a client id or an address. */
    public function audit(): JsonResponse
    {
        $rows = AuditLog::whereIn('action', self::AUDITED)->orderByDesc('id')->limit(50)->get();
        $names = User::whereIn('id', $rows->pluck('user_id')->unique())->pluck('name', 'id');

        return response()->json(['data' => $rows->map(fn (AuditLog $a) => [
            'id' => $a->id, 'action' => $a->action, 'at' => $a->created_at?->toIso8601String(), 'actor' => $names[$a->user_id] ?? null,
            'provider' => $a->meta['provider'] ?? null, 'secret_changed' => $a->meta['secret_changed'] ?? null, 'ok' => $a->meta['ok'] ?? null,
        ])->values()]);
    }

    /** Only providers an administrator can set up exist for these routes. */
    private function setupProvider(string $provider): void
    {
        $manifest = $this->manifests->find($provider);
        abort_unless($manifest && $manifest->isAvailable() && $manifest->requiresAdminSetup(), 404);
    }
}
