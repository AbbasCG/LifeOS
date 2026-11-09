<?php

namespace App\Http\Controllers;

use App\Integrations\Calendar\CalendarWriteException;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Sync\ConflictResolver;
use App\Integrations\Sync\OutboundSync;
use App\Integrations\Sync\SyncPolicy;
use App\Models\CalendarAccount;
use App\Models\SyncConflict;
use App\Services\AuditLogger;
use App\Services\CalendarSyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * How one of the signed-in person's connected accounts is synchronised: the direction, what to do when both sides changed the same event, pausing, a dry run of what
 * would be sent, sending it now, and the conflicts waiting for a decision. Every account and conflict is looked up by owner (somebody else's id is a 404). The direction
 * can never go beyond the person's permissions: they are asked again before every write.
 */
class SyncSettingsController extends Controller
{
    public function __construct(private SyncPolicy $policy, private OutboundSync $outbound, private ConflictResolver $conflicts, private AuditLogger $audit, private CalendarSyncService $sync) {}

    private function account(Request $request, int $id): CalendarAccount
    {
        return CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $account = $this->account($request, $id);
        $data = $request->validate([
            'direction' => ['sometimes', 'string', Rule::in(SyncPolicy::DIRECTIONS)],
            'conflict_policy' => ['sometimes', 'string', Rule::in(SyncPolicy::POLICIES)],
            'paused' => ['sometimes', 'boolean'],
        ]);
        if ($data === []) {
            throw ValidationException::withMessages(['direction' => ['Nothing to change.']]);
        }
        if (isset($data['direction']) && ! in_array($data['direction'], $this->policy->available($account), true)) {
            return response()->json(['message' => 'This service cannot be sent changes through LifeOS, so this direction is not available.', 'code' => 'direction_not_available'], 422);
        }
        $before = ['direction' => $this->policy->direction($account), 'conflict_policy' => $this->policy->policy($account), 'paused' => $this->policy->paused($account)];
        $account->forceFill(array_filter([
            'sync_direction' => $data['direction'] ?? null, 'conflict_policy' => $data['conflict_policy'] ?? null,
        ], fn ($v) => $v !== null) + (isset($data['paused']) ? ['sync_paused_at' => $data['paused'] ? ($account->sync_paused_at ?? now()) : null] : []))->save();
        $after = ['direction' => $this->policy->direction($account), 'conflict_policy' => $this->policy->policy($account), 'paused' => $this->policy->paused($account)];
        if ($before !== $after) {
            $this->audit->log($request->user(), 'integration_sync_settings_changed', $request, ['provider' => $account->provider, 'account_id' => $account->id]
                + array_map(fn ($v) => is_bool($v) ? ($v ? 'yes' : 'no') : $v, array_diff_assoc($after, $before)));
        }

        return response()->json(['data' => $this->policy->summary($account->fresh())]);
    }

    /** What an outbound run would send now, without sending or changing anything. */
    public function preview(Request $request, int $id): JsonResponse
    {
        $account = $this->account($request, $id);

        return response()->json(['data' => $this->outbound->run($account, dry: true)]);
    }

    /** Sends the pending updates now (the same guarded run the scheduler does). */
    public function push(Request $request, int $id): JsonResponse
    {
        $account = $this->account($request, $id);
        $result = $this->outbound->run($account, trigger: 'outbound');
        if (! $result['ran'] && $result['reason'] === 'not_allowed') {
            return response()->json(['message' => 'Sending changes to this service is not allowed for this connection. Change it under Manage permissions.', 'code' => 'permission_denied', 'operation' => 'update', 'reason' => 'not_allowed'], 403);
        }
        if ($result['ran']) {
            $this->audit->log($request->user(), 'sync_outbound_run', $request, ['provider' => $account->provider, 'account_id' => $account->id, 'pushed' => $result['pushed'], 'conflicts' => $result['conflicts'], 'failed' => $result['failed']]);
        }

        return response()->json(['data' => $result]);
    }

    public function conflicts(Request $request, int $id): JsonResponse
    {
        $account = $this->account($request, $id);

        return response()->json(['data' => SyncConflict::where('calendar_account_id', $account->id)->orderByDesc('id')->limit(50)->get()->map->present()->values()]);
    }

    /** Resolve one open conflict. Overwriting what is at the service needs its own explicit confirmation. */
    public function resolve(Request $request, int $conflict): JsonResponse
    {
        $row = SyncConflict::where('user_id', $request->user()->id)->findOrFail($conflict);
        $data = $request->validate(['resolution' => ['required', 'string', Rule::in(ConflictResolver::RESOLUTIONS)], 'confirm_overwrite' => ['sometimes', 'boolean']]);
        if ($data['resolution'] === ConflictResolver::KEEP_LIFEOS && ! ($data['confirm_overwrite'] ?? false)) {
            return response()->json(['message' => 'Confirm that LifeOS may overwrite the version at the service.', 'code' => 'overwrite_confirmation_required'], 422);
        }
        try {
            $resolved = $this->conflicts->resolve($row, $data['resolution'], $request->user(), $request);
        } catch (CalendarWriteException $e) {
            if ($e->reason === 'gone') {
                $this->conflicts->resolve($row, 'keep_external', $request->user(), $request);   // nothing there to disagree with any more
            }
            throw ValidationException::withMessages(['resolution' => [$e->getMessage()]]);
        } catch (ProviderAuthException $e) {
            $this->sync->markRevoked(CalendarAccount::findOrFail($row->calendar_account_id), $e->getMessage());
            throw ValidationException::withMessages(['resolution' => [$e->getMessage().' Reconnect it — nothing was changed.']]);
        }

        return response()->json(['data' => $resolved->present()]);
    }
}
