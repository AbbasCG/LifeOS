<?php

namespace App\Http\Controllers;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Manifest\ManifestRegistry;
use App\Integrations\StatusResolver;
use App\Models\CalendarAccount;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The catalogue behind the Integrations Hub: every known integration with its manifest, the server's real setup state,
 * and the signed-in user's own connections. It never returns credentials or tokens, and never marks anything connected
 * that the server has not actually connected.
 */
class IntegrationCatalogController extends Controller
{
    public function __construct(private ManifestRegistry $manifests, private CalendarProviders $providers, private StatusResolver $status) {}

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $accounts = CalendarAccount::where('user_id', $user->id)->orderBy('id')->get()->groupBy('provider');
        $providers = [];
        foreach ($this->manifests->all() as $manifest) {
            $implementation = $manifest->isAvailable() ? $this->providers->get($manifest->id()) : null;
            // Configured means the OAuth client really has credentials (database or environment); feeds need none.
            $setupReady = $manifest->isAvailable() && (! $manifest->requiresAdminSetup() || ($implementation && $implementation->isConfigured()));
            $rows = ($accounts[$manifest->id()] ?? collect())->map(fn (CalendarAccount $account) => $account->summary() + ['state' => $this->status->forAccount($account)])->values();
            $providers[] = $manifest->toPublic() + [
                'state' => $this->status->forProvider($manifest, $setupReady, $rows->pluck('state')->all()),
                'setup_ready' => $setupReady,
                'accounts' => $rows,
            ];
        }

        return response()->json(['data' => [
            'categories' => collect(ManifestRegistry::CATEGORIES)->map(fn (array $names, string $key) => ['key' => $key, 'name' => $names])->values(),
            'providers' => $providers,
            'can_manage' => $request->user()->can('manage-integrations'),
        ]]);
    }
}
