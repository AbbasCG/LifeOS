<?php

namespace App\Integrations\Sync;

use App\Integrations\Calendar\CalendarWriteException;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Permissions\PermissionDeniedException;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\SyncConflict;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\CalendarSyncService;
use App\Services\CalendarWriteService;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * What happens when a copy LifeOS added was changed at the service AND in LifeOS. Nothing is lost silently: the default (ask) records the conflict and sends nothing; the
 * other choices are explicit policies the person set, each applied through the same guarded writer and each recorded.
 *
 *   keep_external  leave the service as it is and stop trying to send this version (no write).
 *   keep_lifeos    overwrite the service's version with LifeOS's (needs `update`).
 *   keep_both      leave the service's version alone and add the LifeOS version as a new copy (needs `create`).
 */
class ConflictResolver
{
    public const KEEP_EXTERNAL = 'keep_external';

    public const KEEP_LIFEOS = 'keep_lifeos';

    public const KEEP_BOTH = 'keep_both';

    public const RESOLUTIONS = [self::KEEP_EXTERNAL, self::KEEP_LIFEOS, self::KEEP_BOTH];

    public function __construct(private CalendarWriteService $writes, private CalendarSyncService $sync, private AuditLogger $audit, private SyncPolicy $policy) {}

    /** Records a conflict once per copy (a second detection of the same one changes nothing). */
    public function record(CalendarAccount $account, CalendarWriteLink $link, CalendarEvent $event): SyncConflict
    {
        return SyncConflict::firstOrCreate(
            ['calendar_account_id' => $account->id, 'calendar_write_link_id' => $link->id, 'status' => SyncConflict::OPEN],
            ['user_id' => $account->user_id, 'calendar_event_id' => $event->id, 'local_title' => mb_substr($event->title, 0, 255), 'local_starts_at' => $event->starts_at, 'local_ends_at' => $event->ends_at],
        );
    }

    /**
     * Apply the person's standing policy to a conflict found by the schedule. Returns what happened: 'open' (waiting for the person) or the resolution applied.
     * A policy that cannot be carried out (permissions, no calendar) leaves the conflict open instead of guessing.
     */
    public function applyPolicy(CalendarAccount $account, CalendarWriteLink $link, CalendarEvent $event): string
    {
        $conflict = $this->record($account, $link, $event);
        $resolution = match ($this->policy->policy($account)) {
            SyncPolicy::PREFER_EXTERNAL => self::KEEP_EXTERNAL,
            SyncPolicy::PREFER_LIFEOS => self::KEEP_LIFEOS,
            SyncPolicy::KEEP_BOTH => self::KEEP_BOTH,
            default => null,
        };
        if ($resolution === null) {
            return 'open';
        }
        try {
            $this->resolve($conflict, $resolution, null);
        } catch (PermissionDeniedException|CalendarWriteException|ProviderAuthException|ValidationException) {
            return 'open';
        }

        return $resolution;
    }

    /**
     * @throws PermissionDeniedException|CalendarWriteException|ProviderAuthException|ValidationException
     */
    public function resolve(SyncConflict $conflict, string $resolution, ?User $actor, ?Request $request = null): SyncConflict
    {
        if ($conflict->status !== SyncConflict::OPEN) {
            return $conflict;
        }
        $account = CalendarAccount::findOrFail($conflict->calendar_account_id);
        $link = CalendarWriteLink::find($conflict->calendar_write_link_id);
        $event = CalendarEvent::where('user_id', $account->user_id)->find($conflict->calendar_event_id);
        if (! $link || ! $event) {
            // The copy or the LifeOS event is gone: there is nothing left to disagree about.
            return $this->close($conflict, 'gone', $actor, $request);
        }
        match ($resolution) {
            self::KEEP_EXTERNAL => $this->keepExternal($link, $event),
            self::KEEP_LIFEOS => $this->writes->pushUpdate($account, $link, $event, overwrite: true),
            self::KEEP_BOTH => $this->keepBoth($account, $link, $event),
            default => throw ValidationException::withMessages(['resolution' => ['Choose how to resolve it.']]),
        };

        return $this->close($conflict, $resolution, $actor, $request);
    }

    /** No write: the copy is treated as matching what LifeOS holds now, so LifeOS stops trying to send it. The next LifeOS edit is a new decision. */
    private function keepExternal(CalendarWriteLink $link, CalendarEvent $event): void
    {
        $link->forceFill(['title' => $event->title, 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at])->save();
    }

    /** The service's version is left alone and stops being managed by LifeOS; the LifeOS version becomes a new copy. */
    private function keepBoth(CalendarAccount $account, CalendarWriteLink $link, CalendarEvent $event): void
    {
        // The old link is dropped only once the new copy exists (the event there is then the person's own, not LifeOS's to change); see pushCreate.
        $this->writes->pushCreate($account, $event, $link);
    }

    private function close(SyncConflict $conflict, string $resolution, ?User $actor, ?Request $request): SyncConflict
    {
        $conflict->forceFill(['status' => SyncConflict::RESOLVED, 'resolution' => $resolution, 'resolved_at' => now()])->save();
        $user = $actor ?? User::find($conflict->user_id);
        if ($user) {
            $this->audit->log($user, 'sync_conflict_resolved', $request, ['account_id' => $conflict->calendar_account_id, 'resolution' => $resolution, 'by' => $actor ? 'person' : 'policy']);
        }

        return $conflict;
    }
}
