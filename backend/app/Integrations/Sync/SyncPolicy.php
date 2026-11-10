<?php

namespace App\Integrations\Sync;

use App\Integrations\Permissions\ConnectionPermissions;
use App\Models\CalendarAccount;
use App\Models\CalendarWriteLink;
use App\Models\SyncConflict;
use App\Models\SyncRun;

/**
 * How one connection is synchronised: which way, and what to do when both sides changed the same event. Independent of the OAuth scopes and of the person's permissions, but
 * never able to go beyond the permissions: a direction that sends changes is only EFFECTIVE while the person has allowed sending and updating (ConnectionPermissions), and an
 * outbound run asks ConnectionPermissions again before every write.
 *
 * Directions
 *   inbound   the service is read on the schedule (today's behaviour). Nothing is sent by itself.
 *   outbound  LifeOS keeps the copies it added up to date when their LifeOS events change. Reading is not scheduled.
 *   two_way   both of the above.
 *   manual    nothing runs on the schedule; "Sync now" imports once, and changes are sent only by previewing and confirming.
 *
 * Outbound never creates and never deletes by itself: adding a copy and removing one stay explicit, previewed and confirmed (and Delete stays off unless turned on).
 */
class SyncPolicy
{
    public const INBOUND = 'inbound';

    public const OUTBOUND = 'outbound';

    public const TWO_WAY = 'two_way';

    public const MANUAL = 'manual';

    public const DIRECTIONS = [self::INBOUND, self::OUTBOUND, self::TWO_WAY, self::MANUAL];

    public const ASK = 'ask';

    public const PREFER_LIFEOS = 'prefer_lifeos';

    public const PREFER_EXTERNAL = 'prefer_external';

    public const KEEP_BOTH = 'keep_both';

    public const POLICIES = [self::ASK, self::PREFER_LIFEOS, self::PREFER_EXTERNAL, self::KEEP_BOTH];

    public function __construct(private ConnectionPermissions $permissions) {}

    /** Whether the service can be sent changes at all (an adapter exists and the server allows it). */
    public function canSend(CalendarAccount $account): bool
    {
        return in_array(ConnectionPermissions::UPDATE, $this->permissions->capabilities($account->provider), true);
    }

    /** @return list<string> the directions this connection can be set to */
    public function available(CalendarAccount $account): array
    {
        return $this->canSend($account) ? self::DIRECTIONS : [self::INBOUND, self::MANUAL];
    }

    public function direction(CalendarAccount $account): string
    {
        return in_array($account->sync_direction, self::DIRECTIONS, true) ? $account->sync_direction : self::INBOUND;
    }

    public function policy(CalendarAccount $account): string
    {
        return in_array($account->conflict_policy, self::POLICIES, true) ? $account->conflict_policy : self::ASK;
    }

    public function paused(CalendarAccount $account): bool
    {
        return $account->sync_paused_at !== null;
    }

    /** Whether the person's permissions let an outbound run update copies right now. */
    public function mayPushNow(CalendarAccount $account): bool
    {
        return $this->canSend($account) && $this->permissions->allows($account, ConnectionPermissions::EXPORT) && $this->permissions->allows($account, ConnectionPermissions::UPDATE);
    }

    /** Whether the scheduler should read the service for this connection. */
    public function scheduledInbound(CalendarAccount $account): bool
    {
        return ! $this->paused($account) && in_array($this->direction($account), [self::INBOUND, self::TWO_WAY], true);
    }

    /** Whether the scheduler should send updates for this connection (the direction wants it and the permissions allow it). */
    public function scheduledOutbound(CalendarAccount $account): bool
    {
        return ! $this->paused($account) && in_array($this->direction($account), [self::OUTBOUND, self::TWO_WAY], true) && $this->mayPushNow($account);
    }

    /** What the direction amounts to once permissions are taken into account, and why it differs from the setting. */
    public function effective(CalendarAccount $account): array
    {
        $set = $this->direction($account);
        if (in_array($set, [self::OUTBOUND, self::TWO_WAY], true) && ! $this->mayPushNow($account)) {
            $reason = $this->canSend($account) ? 'permissions' : 'unsupported';

            return ['direction' => $set === self::TWO_WAY ? self::INBOUND : self::MANUAL, 'reason' => $reason];
        }

        return ['direction' => $set, 'reason' => null];
    }

    /**
     * The database facts summary() shows, for many accounts at once (a handful of queries however many accounts there are).
     *
     * @param  iterable<int>  $accountIds
     * @return array<int, array{copies: int, pending: int, open_conflicts: int, last_outbound: ?SyncRun}> keyed by account id; every requested id is present
     */
    public function facts(iterable $accountIds): array
    {
        $ids = collect($accountIds)->map(fn ($id) => (int) $id)->unique()->values();
        $facts = $ids->mapWithKeys(fn (int $id) => [$id => ['copies' => 0, 'pending' => 0, 'open_conflicts' => 0, 'last_outbound' => null]])->all();
        if ($ids->isEmpty()) {
            return $facts;
        }
        // Only the columns inSync() compares are loaded (links and their events), never whole rows or payloads.
        CalendarWriteLink::query()->whereIn('calendar_account_id', $ids)
            ->select(['id', 'calendar_account_id', 'calendar_event_id', 'title', 'starts_at', 'ends_at'])
            ->with('event:id,title,starts_at,ends_at')
            ->get()
            ->each(function (CalendarWriteLink $l) use (&$facts) {
                $facts[$l->calendar_account_id]['copies']++;
                if ($l->calendar_event_id !== null && $l->event && ! $l->inSync()) {
                    $facts[$l->calendar_account_id]['pending']++;
                }
            });
        SyncConflict::query()->whereIn('calendar_account_id', $ids)->where('status', SyncConflict::OPEN)
            ->selectRaw('calendar_account_id, count(*) as aggregate')->groupBy('calendar_account_id')->pluck('aggregate', 'calendar_account_id')
            ->each(function ($count, $accountId) use (&$facts) {
                $facts[(int) $accountId]['open_conflicts'] = (int) $count;
            });
        $latest = SyncRun::query()->whereIn('calendar_account_id', $ids)->where('trigger', 'outbound')->selectRaw('max(id) as id')->groupBy('calendar_account_id')->pluck('id');
        SyncRun::query()->whereIn('id', $latest)->get()->each(function (SyncRun $r) use (&$facts) {
            $facts[$r->calendar_account_id]['last_outbound'] = $r;
        });

        return $facts;
    }

    /**
     * @param  array{copies: int, pending: int, open_conflicts: int, last_outbound: ?SyncRun}|null  $facts  prefetched by facts(); looked up for this one account when omitted
     * @return array<string, mixed> only facts that can be shown from the database
     */
    public function summary(CalendarAccount $account, ?array $facts = null): array
    {
        $facts ??= $this->facts([$account->id])[$account->id];
        $effective = $this->effective($account);
        $last = $facts['last_outbound'];

        return [
            'direction' => $this->direction($account), 'effective_direction' => $effective['direction'], 'effective_reason' => $effective['reason'], 'available_directions' => $this->available($account),
            'conflict_policy' => $this->policy($account), 'paused' => $this->paused($account), 'paused_at' => $account->sync_paused_at?->toIso8601String(),
            'copies' => $facts['copies'], 'copies_pending' => $facts['pending'], 'open_conflicts' => $facts['open_conflicts'],
            'last_outbound' => $last?->present(),
        ];
    }
}
