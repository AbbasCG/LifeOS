<?php

namespace App\Http\Controllers;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\ConnectedProvider;
use App\Integrations\Calendar\IcsFeedFetcher;
use App\Integrations\Calendar\IcsProvider;
use App\Integrations\Calendar\ProviderException;
use App\Integrations\Calendar\RateLimitedException;
use App\Integrations\Calendar\TokenSet;
use App\Integrations\Calendar\WritableCalendar;
use App\Integrations\ConnectedCatalog;
use App\Integrations\OAuth\OAuthStateStore;
use App\Integrations\Permissions\ConnectionPermissions;
use App\Integrations\Sync\SyncPolicy;
use App\Integrations\Vault\CredentialVault;
use App\Models\CalendarAccount;
use App\Models\ExternalTask;
use App\Models\SyncRun;
use App\Models\Task;
use App\Services\AuditLogger;
use App\Services\CalendarSyncService;
use App\Services\CalendarWriteService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class IntegrationController extends Controller
{
    public const STATE_TTL = 600;

    /** Implemented providers that can be connected (see CalendarProviders). */
    public const PROVIDERS = ['google', 'outlook', 'google_tasks', 'microsoft_todo', 'todoist'];

    public function __construct(private CalendarProviders $providers, private CalendarSyncService $sync, private AuditLogger $audit, private ConnectedCatalog $catalog, private CalendarWriteService $writes) {}

    /**
     * The Connected Accounts Hub: implemented providers with their state and the user's accounts, grouped by category
     * with the planned integrations. Never includes tokens.
     */
    public function index(Request $request): JsonResponse
    {
        $all = CalendarAccount::where('user_id', $request->user()->id)->orderBy('created_at')->get();
        // The newest five runs of EACH account (a window function, so a chatty account cannot crowd out the others), and the database facts of all accounts in a few queries.
        $newest = SyncRun::query()->whereIn('calendar_account_id', $all->pluck('id'))
            ->selectRaw('sync_runs.*, row_number() over (partition by calendar_account_id order by started_at desc, id desc) as run_rank');
        $runs = SyncRun::query()->fromSub($newest, 'sync_runs')->where('run_rank', '<=', 5)->orderBy('calendar_account_id')->orderByDesc('started_at')->orderByDesc('id')->get()->groupBy('calendar_account_id');
        $facts = app(SyncPolicy::class)->facts($all->pluck('id'));
        $accounts = $all->map(fn (CalendarAccount $a) => $a->setAttribute('recent_runs', $runs->get($a->id, collect())->take(5)->map(fn (SyncRun $r) => $r->present())->values()))->groupBy('provider');
        $admin = $request->user()->can('manage-integrations');
        $present = fn (ConnectedProvider $provider) => [
            'provider' => $provider->name(),
            'label' => $provider->label(),
            'category' => $provider->category() === 'tasks' ? 'tasks' : 'calendars',
            'implemented' => true,
            'configured' => $provider->isConfigured(),
            'status' => ! $provider->isConfigured() ? 'needs_configuration' : (app(CredentialVault::class)->connectionsAllowed($provider->name()) ? 'available' : 'disabled'),
            'scopes' => $provider->scopeSummary(),
            // Setup details (variable names, redirect address) are for administrators; an ordinary person is only told to ask one.
            'env_keys' => $admin ? $provider->envKeys() : [],
            'redirect_uri' => $admin ? $provider->redirectUri() : null,
            'accounts' => $accounts->get($provider->name(), collect())->map(fn (CalendarAccount $a) => $a->summary($facts[$a->id]) + ['recent_runs' => $a->getAttribute('recent_runs'), 'write' => $this->writes->state($a, $facts[$a->id]['copies'])])->values(),
            'supports_write' => $this->writes->featureEnabled() && $provider instanceof WritableCalendar,
            'required_scopes' => $provider->requiredScopes(),
            'connect_mode' => $provider instanceof IcsProvider ? 'url' : 'oauth',
            // What LifeOS can do with this service at all (read-only services have no write adapter), and the choices offered per connection.
            'capabilities' => app(ConnectionPermissions::class)->capabilities($provider->name()),
            'presets' => app(ConnectionPermissions::class)->presets($provider->name()),
        ];

        return response()->json([
            'providers' => collect($this->providers->all())->map($present)->values(),
            'categories' => $this->catalog->categories($present),
            'ai_connected_data' => (bool) ($request->user()->preferences()['ai_connected_data'] ?? false),
        ]);
    }

    public function connect(Request $request, string $provider): JsonResponse
    {
        $driver = $this->providers->get($provider);
        abort_unless($driver !== null, 404);
        if (! $driver->isConfigured()) {
            throw ValidationException::withMessages(['provider' => ["{$driver->label()} is not configured on this server yet. An administrator must add OAuth client credentials."]]);
        }
        if (! app(CredentialVault::class)->connectionsAllowed($provider)) {
            throw ValidationException::withMessages(['provider' => ["New {$driver->label()} connections are switched off by an administrator. Accounts that are already connected keep working."]]);
        }
        // A random state and PKCE verifier kept on the server, bound to this person and this provider, valid for ten minutes and usable once.
        // A provider without PKCE (Todoist) simply ignores the challenge.
        $flow = app(OAuthStateStore::class)->begin($request->user(), $provider, '/settings/integrations');

        return response()->json(['authorization_url' => $driver->authorizationUrl($flow['state'], $flow['challenge'])]);
    }

    /**
     * OAuth redirect target. Validates the one-time state, exchanges the code, stores encrypted tokens and runs a first sync.
     */
    public function callback(Request $request, string $provider): RedirectResponse
    {
        $driver = $this->providers->get($provider);
        abort_unless($driver !== null, 404);
        $back = fn (string $param) => redirect()->away(rtrim((string) config('app.frontend_url'), '/').'/settings/integrations?'.$param);
        // The route is behind sign-in (a guest is sent back by bootstrap/app.php with error=session); the state must belong to exactly this person.
        $pending = app(OAuthStateStore::class)->consume((string) $request->query('state', ''), $request->user(), $provider);
        if (! $pending) {
            return $back('error=state');
        }
        if ($request->filled('error') || ! $request->filled('code')) {
            return $back('error=denied');
        }
        // An administrator may have switched the provider off, or removed its credentials, while the person was signing in.
        if (! $driver->isConfigured()) {
            return $back('error=not_configured&provider='.$provider);
        }
        if (! app(CredentialVault::class)->connectionsAllowed($provider)) {
            return $back('error=provider_disabled&provider='.$provider);
        }
        try {
            $tokens = $driver->exchangeCode((string) $request->query('code'), $pending['verifier']);
            $profile = $driver->account($tokens->accessToken);
        } catch (ProviderException $e) {
            report($e);

            return $back('error=exchange');
        }
        if ($pending['account_id'] !== null) {
            return $back($this->grantWrite($request, $driver, $pending['account_id'], $tokens, $profile));
        }
        $account = CalendarAccount::firstOrNew(['user_id' => $request->user()->id, 'provider' => $provider, 'external_account_id' => $profile['id']]);
        if (! $account->exists) {
            // New connections start with only the primary calendar or list included; the user chooses the rest.
            $account->collections = [];
            // ...and with the least LifeOS may do: read, sync and import. Sending anything to the provider is something the person turns on later.
            $account->permissions = app(ConnectionPermissions::class)->defaultsForNewConnection($provider);
            $account->permissions_changed_at = now();
        }
        $account->fill([
            'email' => $profile['email'],
            'display_name' => $profile['name'],
            'access_token' => $tokens->accessToken,
            'refresh_token' => $tokens->refreshToken ?? $account->refresh_token,
            'token_expires_at' => $tokens->expiresAt,
            'scopes' => $tokens->scopes,
            'status' => 'active',
            'last_error' => null,
        ] + ($driver instanceof WritableCalendar && trim((string) $tokens->scopes) !== '' && ! $driver->writeScopeGranted($tokens->scopes)
            // The provider reported scopes and they do not carry the write permission (a read-only reconnect; a response without a scope field says nothing, so the grant stays), so the old grant must not keep showing as active.
            ? ['write_granted_at' => null, 'write_calendar_id' => null, 'write_calendar_name' => null]
            : []))->save();
        $this->audit->log($request->user(), 'integration_connected', $request, ['provider' => $provider]);
        // Some consent screens let people untick permissions. Without the read scope nothing can be imported, so say so
        // instead of showing an empty "connected" account.
        $granted = $driver->scopesGranted($tokens->scopes);
        $account->forceFill(['scopes_ok' => $granted])->save();
        if ($granted === false) {
            $account->forceFill(['status' => 'error', 'last_error' => "{$driver->label()} did not grant the read permission LifeOS needs. Reconnect and allow access."])->save();

            return $back('error=scope&provider='.$provider);
        }
        try {
            $this->sync->sync($account, 'connect');
        } catch (ProviderException) {
            // The scheduled sync retries; the account shows the error meanwhile.
        }

        return $back('connected='.$provider);
    }

    /**
     * Subscribe to a read-only calendar feed (.ics / webcal). The address is validated by reading it once, stored
     * encrypted like a token, and never returned or logged.
     */
    public function subscribe(Request $request, IcsProvider $ics): JsonResponse
    {
        $data = $request->validate(['url' => ['required', 'string', 'max:2048']]);
        $user = $request->user();
        if (CalendarAccount::where('user_id', $user->id)->where('provider', 'ics')->count() >= IcsProvider::MAX_PER_USER) {
            throw ValidationException::withMessages(['url' => ['You can subscribe to up to '.IcsProvider::MAX_PER_USER.' calendar feeds.']]);
        }
        try {
            $url = app(IcsFeedFetcher::class)->normalise($data['url']);
            $profile = $ics->account($url);
        } catch (ProviderException $e) {
            throw ValidationException::withMessages(['url' => [$e->getMessage()]]);
        }
        if (CalendarAccount::where('user_id', $user->id)->where('provider', 'ics')->where('external_account_id', $profile['id'])->exists()) {
            throw ValidationException::withMessages(['url' => ['You are already subscribed to this calendar.']]);
        }
        $account = CalendarAccount::create(['user_id' => $user->id, 'provider' => 'ics', 'external_account_id' => $profile['id'], 'email' => $profile['email'], 'display_name' => $profile['name'],
            'access_token' => $url, 'status' => 'active', 'collections' => []]);
        $this->audit->log($user, 'integration_connected', $request, ['provider' => 'ics', 'host' => $profile['email']]);
        try {
            $this->sync->sync($account, 'connect');
        } catch (ProviderException) {
            // Shown on the account; the scheduled sync retries.
        }

        return response()->json(['account' => $account->fresh()->summary()], 201);
    }

    /**
     * Second consent for an existing account: store the tokens that now include the write permission. Refused when a
     * different account signed in or the write permission was not granted. Nothing is written yet — the user still
     * picks a calendar and confirms every change.
     *
     * @param  array{id: string, email: string|null, name: string|null}  $profile
     */
    private function grantWrite(Request $request, ConnectedProvider $driver, int $accountId, TokenSet $tokens, array $profile): string
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->find($accountId);
        if (! $account || $account->provider !== $driver->name() || $account->external_account_id !== $profile['id']) {
            return 'error=write_account&provider='.$driver->name();
        }
        if (! $driver instanceof WritableCalendar || ! $driver->writeScopeGranted($tokens->scopes)) {
            return 'error=write_scope&provider='.$driver->name();
        }
        $account->forceFill([
            'access_token' => $tokens->accessToken, 'refresh_token' => $tokens->refreshToken ?? $account->refresh_token, 'token_expires_at' => $tokens->expiresAt,
            'scopes' => $tokens->scopes, 'write_granted_at' => now(), 'status' => 'active', 'last_error' => null,
        ])->save();
        $this->audit->log($request->user(), 'calendar_write_granted', $request, ['provider' => $driver->name(), 'account_id' => $account->id]);

        return 'write_granted='.$account->id;
    }

    public function sync(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        if ($account->status === 'revoked') {
            throw ValidationException::withMessages(['account' => ['Access was revoked. Reconnect this calendar.']]);
        }
        if ($account->scopes_ok === false) {
            throw ValidationException::withMessages(['account' => ['The read permission was not granted. Reconnect and allow access.']]);
        }
        try {
            $imported = $this->sync->sync($account, 'manual');
        } catch (RateLimitedException $e) {
            return response()->json(['message' => $e->getMessage(), 'retry_after' => $e->retryAfter, 'account' => $account->fresh()->summary()], 429);
        } catch (ProviderException $e) {
            return response()->json(['message' => $e->getMessage(), 'account' => $account->fresh()->summary()], 502);
        }
        $run = SyncRun::where('calendar_account_id', $account->id)->latest('id')->first();

        return response()->json(['imported' => $imported, 'run' => $run?->present(), 'account' => $account->fresh()->summary()]);
    }

    /**
     * Choose which calendars or task lists of an account are imported. Excluded ones are removed on the next sync,
     * which runs immediately.
     */
    public function update(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        $data = $request->validate(['included' => 'present|array|max:250', 'included.*' => 'string|max:512|distinct']);
        $known = collect($account->collections ?? []);
        if (collect($data['included'])->diff($known->pluck('id'))->isNotEmpty()) {
            throw ValidationException::withMessages(['included' => ['Choose from the calendars or lists of this account.']]);
        }
        $account->collections = $known->map(fn (array $c) => ['included' => in_array($c['id'], $data['included'], true)] + $c)->values()->all();
        $account->save();
        $this->audit->log($request->user(), 'integration_collections_changed', $request, ['provider' => $account->provider, 'included' => count($data['included'])]);
        try {
            $imported = $account->status === 'revoked' ? 0 : $this->sync->sync($account, 'selection');
        } catch (ProviderException $e) {
            return response()->json(['message' => $e->getMessage(), 'account' => $account->fresh()->summary()], 502);
        }

        return response()->json(['imported' => $imported, 'account' => $account->fresh()->summary()]);
    }

    /**
     * Read-only tasks imported from connected apps that have not been copied into LifeOS yet.
     */
    public function tasks(Request $request): JsonResponse
    {
        $user = $request->user();
        $copied = Task::where('user_id', $user->id)->whereNotNull('source_ref')->pluck('source_ref')->flip();
        $tasks = ExternalTask::query()->join('calendar_accounts', 'calendar_accounts.id', '=', 'external_tasks.calendar_account_id')
            ->where('external_tasks.user_id', $user->id)->where('calendar_accounts.status', '!=', 'revoked')
            ->orderByRaw("CASE WHEN external_tasks.status = 'open' THEN 0 ELSE 1 END")->orderByRaw('external_tasks.due_at IS NULL, external_tasks.due_at ASC')->limit(300)
            ->get(['external_tasks.*', 'calendar_accounts.provider', 'calendar_accounts.email as account_email'])
            ->reject(fn (ExternalTask $t) => $copied->has($t->sourceRef($t->provider)))
            ->map(fn (ExternalTask $t) => [
                'id' => $t->id, 'provider' => $t->provider, 'source' => $this->providers->get($t->provider)?->label() ?? $t->provider, 'account' => $t->account_email,
                'list' => $t->list_name, 'title' => $t->title, 'due_at' => $t->due_at?->toIso8601String(), 'due_is_date' => $t->due_is_date, 'priority' => $t->priority, 'url' => $t->url,
                'status' => $t->status, 'completed_at' => $t->completed_at?->toIso8601String(),
            ])->values();

        return response()->json($tasks);
    }

    /**
     * Copy an imported task into LifeOS so it can be planned and completed here. The source is never changed, and
     * copying twice returns the existing LifeOS task instead of creating a duplicate.
     */
    public function copyTask(Request $request, int $id): JsonResponse
    {
        $user = $request->user();
        $external = ExternalTask::where('user_id', $user->id)->with('account')->findOrFail($id);
        // Copying an item into LifeOS is "import": the person may have switched it off for this connection.
        app(ConnectionPermissions::class)->authorize($external->account, ConnectionPermissions::IMPORT, $request);
        $ref = $external->sourceRef($external->account->provider);
        $existing = Task::where('user_id', $user->id)->where('source_ref', $ref)->first();
        if ($existing) {
            return response()->json($existing);
        }
        $label = $this->providers->get($external->account->provider)?->label() ?? $external->account->provider;
        $task = Task::create([
            'user_id' => $user->id, 'title' => mb_substr($external->title, 0, 200), 'status' => 'todo', 'priority' => $external->priority ?? 'medium',
            'estimated_minutes' => 30, 'due_at' => $external->due_at, 'due_all_day' => (bool) ($external->due_at && $external->due_is_date), 'source_ref' => $ref, 'tags' => [mb_strtolower(str_replace(' ', '-', $label))],
            'notes' => $external->url ? "Copied from {$label}: {$external->url}" : "Copied from {$label}.",
        ]);
        $this->audit->log($user, 'connected_task_copied', $request, ['provider' => $external->account->provider]);

        return response()->json($task, 201);
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

        return response()->json(['message' => 'Disconnected. Imported events and tasks were removed.']);
    }
}
