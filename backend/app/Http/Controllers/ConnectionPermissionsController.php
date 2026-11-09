<?php

namespace App\Http\Controllers;

use App\Integrations\Permissions\ConnectionPermissions;
use App\Models\CalendarAccount;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Choose what LifeOS may do with one of the signed-in person's connected accounts. The account is looked up by owner (another person's id is a 404), the choice is
 * validated against what the service can actually do, enabling Delete needs its own explicit confirmation, and every change is audited. The route needs a recent
 * password confirmation, like the other settings that decide what leaves LifeOS.
 */
class ConnectionPermissionsController extends Controller
{
    public function __construct(private ConnectionPermissions $permissions) {}

    public function show(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);

        return response()->json(['data' => $this->permissions->summary($account)]);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        $data = $request->validate([
            'preset' => ['nullable', 'string', Rule::in(array_keys(ConnectionPermissions::PRESETS))],
            'permissions' => ['nullable', 'array', 'max:'.count(ConnectionPermissions::OPS)],
            'permissions.*' => ['string', 'distinct', Rule::in(ConnectionPermissions::OPS)],
            'confirm_delete' => ['sometimes', 'boolean'],
        ]);
        if (! isset($data['preset']) && ! isset($data['permissions'])) {
            throw ValidationException::withMessages(['permissions' => ['Choose a preset or a list of permissions.']]);
        }
        if (isset($data['preset'], $data['permissions'])) {
            throw ValidationException::withMessages(['permissions' => ['Send either a preset or a list, not both.']]);
        }
        if (isset($data['preset']) && ! in_array($data['preset'], $this->permissions->presets($account->provider), true)) {
            throw ValidationException::withMessages(['preset' => ['This service cannot do that through LifeOS.']]);
        }
        $ops = $this->permissions->normalise($account->provider, isset($data['preset']) ? $this->permissions->presetOps($account->provider, $data['preset']) : $data['permissions']);

        // Delete is the one operation that cannot be taken back, so turning it ON asks separately, in words, and the server insists.
        $before = $this->permissions->granted($account);
        if (in_array(ConnectionPermissions::DELETE, $ops, true) && ! in_array(ConnectionPermissions::DELETE, $before, true) && ! ($data['confirm_delete'] ?? false)) {
            return response()->json(['message' => 'Confirm that LifeOS may remove events it added before turning Delete on.', 'code' => 'delete_confirmation_required'], 422);
        }
        $diff = $this->permissions->set($account, $ops, $request->user(), $request);

        return response()->json(['data' => $this->permissions->summary($account->fresh()) + ['changes' => $diff]]);
    }
}
