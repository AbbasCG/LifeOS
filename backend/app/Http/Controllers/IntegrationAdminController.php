<?php

namespace App\Http\Controllers;

use App\Http\Requests\SaveAppCredentialsRequest;
use App\Integrations\Manifest\ManifestRegistry;
use App\Integrations\Vault\CredentialVault;
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
    public function __construct(private ManifestRegistry $manifests, private CredentialVault $vault, private AuditLogger $audit) {}

    public function index(Request $request): JsonResponse
    {
        $data = [];
        foreach ($this->manifests->all() as $manifest) {
            if ($manifest->isAvailable() && $manifest->requiresAdminSetup()) {
                $data[] = ['name' => $manifest->toPublic()['name']] + $this->vault->status($manifest->id());
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
}
