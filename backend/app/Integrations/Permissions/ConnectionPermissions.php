<?php

namespace App\Integrations\Permissions;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\WritableCalendar;
use App\Models\CalendarAccount;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * What LifeOS may do with one connected account. Four different things are kept apart on purpose:
 *
 *  1. the provider's OAuth scopes (what the token the provider issued can do; LifeOS cannot narrow them),
 *  2. the provider's capabilities (what LifeOS has an adapter for: a task service has no write adapter at all),
 *  3. the person's choice for this connection (this class: `calendar_accounts.permissions`),
 *  4. sync policies (direction, conflicts: a later step).
 *
 * An operation is allowed only if the adapter can do it, the person allowed it, and (for writes) the provider granted the access it needs. Every place that
 * talks to the provider or copies its data calls authorize() first, so a disabled button in the browser is never the protection. Saying "no Delete" here does not change
 * the token: a broad write scope at Google still permits deletion on Google's side; LifeOS simply never asks for it.
 */
class ConnectionPermissions
{
    public const READ = 'read';

    public const SYNC = 'sync';

    public const IMPORT = 'import';

    public const EXPORT = 'export';

    public const CREATE = 'create';

    public const UPDATE = 'update';

    public const DELETE = 'delete';

    public const OPS = [self::READ, self::SYNC, self::IMPORT, self::EXPORT, self::CREATE, self::UPDATE, self::DELETE];

    /** Operations that send something to the provider. Each needs `export` as well as its own permission. */
    public const WRITES = [self::CREATE, self::UPDATE, self::DELETE];

    private const BASE = [self::READ, self::SYNC, self::IMPORT];

    /** The choices offered, least first. */
    public const PRESETS = [
        'read_only' => self::BASE,
        'read_create' => [...self::BASE, self::EXPORT, self::CREATE],
        'read_create_update' => [...self::BASE, self::EXPORT, self::CREATE, self::UPDATE],
        'full' => [...self::BASE, self::EXPORT, self::CREATE, self::UPDATE, self::DELETE],
    ];

    public function __construct(private CalendarProviders $providers, private AuditLogger $audit) {}

    // ---- what the provider can do (from the code, not from a setting) ----

    /** @return list<string> */
    public function capabilities(string $provider): array
    {
        $driver = $this->providers->get($provider);
        if (! $driver) {
            return [];
        }
        $caps = [self::READ, self::SYNC];
        if ($driver->category() === 'tasks') {
            $caps[] = self::IMPORT;
        }
        if ($driver instanceof WritableCalendar && config('calendar_write.enabled')) {
            array_push($caps, self::EXPORT, self::CREATE, self::UPDATE, self::DELETE);
        }

        return $caps;
    }

    /** @return list<string> the presets this provider offers: a preset that sends changes is offered only where the adapter can send them */
    public function presets(string $provider): array
    {
        $caps = $this->capabilities($provider);

        return array_keys(array_filter(self::PRESETS, fn (array $ops) => array_diff(array_intersect($ops, [self::EXPORT, ...self::WRITES]), $caps) === []));
    }

    /**
     * The operations of a preset for this provider (the ones it cannot do at all, such as importing from a calendar, are left out).
     *
     * @return list<string>
     */
    public function presetOps(string $provider, string $preset): array
    {
        return $this->ordered(array_values(array_intersect(self::PRESETS[$preset] ?? [], $this->capabilities($provider))));
    }

    // ---- what the person allowed ----

    /** @return list<string> */
    public function granted(CalendarAccount $account): array
    {
        $caps = $this->capabilities($account->provider);
        if ($account->permissions === null) {
            // Never chosen: what the account could already do, without Delete. Adding events had its own opt-in, so only an account that took it keeps adding and changing.
            $ops = self::BASE;
            if ($account->write_granted_at !== null) {
                array_push($ops, self::EXPORT, self::CREATE, self::UPDATE);
            }
        } else {
            $ops = (array) $account->permissions;
        }

        return $this->ordered(array_values(array_intersect($ops, $caps)));
    }

    public function isLegacy(CalendarAccount $account): bool
    {
        return $account->permissions === null;
    }

    /** @return list<string> allowed and actually possible now (a write also needs the provider's write access and a live account) */
    public function effective(CalendarAccount $account): array
    {
        return array_values(array_filter($this->granted($account), fn (string $op) => $this->denial($account, $op) === null));
    }

    /** @return array{reason: string, message: string}|null null when the operation may go ahead */
    public function denial(CalendarAccount $account, string $op): ?array
    {
        if (! in_array($op, self::OPS, true)) {
            return ['reason' => 'unknown', 'message' => 'Unknown operation.'];
        }
        if (! in_array($op, $this->capabilities($account->provider), true)) {
            return ['reason' => 'unsupported', 'message' => 'This service cannot do that through LifeOS.'];
        }
        if (! in_array($op, $this->granted($account), true)) {
            return ['reason' => 'not_allowed', 'message' => 'You have not allowed LifeOS to do that with this connection. Change it under Manage permissions.'];
        }
        if (in_array($op, [...self::WRITES, self::EXPORT], true)) {
            if (! in_array(self::EXPORT, $this->granted($account), true)) {
                return ['reason' => 'not_allowed', 'message' => 'Sending changes to this service is switched off. Change it under Manage permissions.'];
            }
            if ($account->write_granted_at === null) {
                return ['reason' => 'reconsent_required', 'message' => 'The service has not given LifeOS the access this needs. Allow it again when asked, then try once more.'];
            }
        }
        if ($account->status === 'revoked') {
            return ['reason' => 'revoked', 'message' => 'Access was revoked. Reconnect this account first.'];
        }

        return null;
    }

    public function allows(CalendarAccount $account, string $op): bool
    {
        return $this->denial($account, $op) === null;
    }

    /** @throws PermissionDeniedException */
    public function authorize(CalendarAccount $account, string $op, ?Request $request = null): void
    {
        $denial = $this->denial($account, $op);
        if ($denial === null) {
            return;
        }
        $user = User::find($account->user_id);
        if ($user) {
            $this->audit->log($user, 'integration_permission_denied', $request, ['provider' => $account->provider, 'account_id' => $account->id, 'operation' => $op, 'reason' => $denial['reason']]);
        }

        throw new PermissionDeniedException($op, $denial['reason'], $denial['message']);
    }

    // ---- changing the choice ----

    /**
     * Validate a requested set: only operations this provider can do, reading always on, a write only together with `export`.
     *
     * @param  list<string>  $ops
     * @return list<string>
     *
     * @throws ValidationException
     */
    public function normalise(string $provider, array $ops): array
    {
        $ops = array_values(array_unique($ops));
        $unknown = array_diff($ops, self::OPS);
        if ($unknown !== []) {
            throw ValidationException::withMessages(['permissions' => ['Unknown permission: '.implode(', ', $unknown).'.']]);
        }
        $unsupported = array_diff($ops, $this->capabilities($provider));
        if ($unsupported !== []) {
            throw ValidationException::withMessages(['permissions' => ['This service cannot do that through LifeOS: '.implode(', ', $unsupported).'.']]);
        }
        if (! in_array(self::READ, $ops, true)) {
            throw ValidationException::withMessages(['permissions' => ['Reading cannot be turned off; disconnect the account instead.']]);
        }
        if (array_intersect($ops, self::WRITES) !== [] && ! in_array(self::EXPORT, $ops, true)) {
            throw ValidationException::withMessages(['permissions' => ['Creating, changing or removing needs sending changes to be allowed.']]);
        }
        if (in_array(self::EXPORT, $ops, true) && array_intersect($ops, self::WRITES) === []) {
            throw ValidationException::withMessages(['permissions' => ['Allow at least one of create, update or delete, or switch sending off.']]);
        }

        return $this->ordered($ops);
    }

    /**
     * @param  list<string>  $ops  already normalised
     * @return array{added: list<string>, removed: list<string>}
     */
    public function set(CalendarAccount $account, array $ops, User $actor, ?Request $request = null): array
    {
        $before = $this->granted($account);
        $account->forceFill(['permissions' => $ops, 'permissions_changed_at' => now()])->save();
        $diff = ['added' => array_values(array_diff($ops, $before)), 'removed' => array_values(array_diff($before, $ops))];
        if ($diff['added'] !== [] || $diff['removed'] !== []) {
            $this->audit->log($actor, 'integration_permissions_changed', $request, ['provider' => $account->provider, 'account_id' => $account->id] + ['added' => implode(',', $diff['added']), 'removed' => implode(',', $diff['removed'])]);
        }

        return $diff;
    }

    /** The choice a new connection starts with: reading, syncing and importing only. */
    public function defaultsForNewConnection(string $provider): array
    {
        return $this->ordered(array_values(array_intersect(self::BASE, $this->capabilities($provider))));
    }

    // ---- what the API shows ----

    /** @return array<string, mixed> */
    public function summary(CalendarAccount $account): array
    {
        $caps = $this->capabilities($account->provider);
        $granted = $this->granted($account);
        $effective = $this->effective($account);
        $preset = null;
        foreach ($this->presets($account->provider) as $name) {
            if ($this->presetOps($account->provider, $name) === $granted) {
                $preset = $name;
            }
        }
        $blocked = [];
        foreach (array_diff($granted, $effective) as $op) {
            $blocked[$op] = $this->denial($account, $op)['reason'] ?? 'unknown';
        }

        return [
            'granted' => $granted, 'effective' => $effective, 'capabilities' => $caps, 'presets' => $this->presets($account->provider), 'preset' => $preset,
            'legacy' => $this->isLegacy($account), 'blocked' => (object) $blocked, 'changed_at' => $account->permissions_changed_at?->toIso8601String(),
        ];
    }

    /**
     * @param  list<string>  $ops
     * @return list<string>
     */
    private function ordered(array $ops): array
    {
        return array_values(array_intersect(self::OPS, $ops));
    }
}
