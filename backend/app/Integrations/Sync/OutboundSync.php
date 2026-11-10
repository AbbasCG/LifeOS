<?php

namespace App\Integrations\Sync;

use App\Integrations\Calendar\CalendarWriteException;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\ProviderException;
use App\Integrations\Calendar\RateLimitedException;
use App\Integrations\Permissions\PermissionDeniedException;
use App\Logging\SecretRedactor;
use App\Models\CalendarAccount;
use App\Models\CalendarWriteLink;
use App\Models\SyncConflict;
use App\Models\SyncRun;
use App\Services\CalendarSyncService;
use App\Services\CalendarWriteService;
use Illuminate\Support\Facades\Cache;

/**
 * Keeps the copies LifeOS added up to date when their LifeOS events change. It only UPDATES copies that already exist; it never creates one and never deletes one by itself (those
 * stay previewed and confirmed). It reuses the one guarded writer (CalendarWriteService::pushUpdate: permission, etag, no retry of a write), one account at a time under the same
 * lock as a confirmed change, a bounded number of copies per run, and it stops at the first sign the service wants it to slow down or the access ended.
 * A run with $dry=true changes nothing anywhere and only reports what it would send.
 */
class OutboundSync
{
    public const BATCH = 25;

    public function __construct(private CalendarWriteService $writes, private ConflictResolver $conflicts, private SyncPolicy $policy, private CalendarSyncService $sync) {}

    /**
     * @return array{ran: bool, reason: ?string, pushed: int, conflicts: int, awaiting: int, gone: int, failed: int, pending: int, planned: list<array<string, mixed>>}
     */
    public function run(CalendarAccount $account, bool $dry = false, string $trigger = 'outbound'): array
    {
        $out = ['ran' => false, 'reason' => null, 'pushed' => 0, 'conflicts' => 0, 'awaiting' => 0, 'gone' => 0, 'failed' => 0, 'pending' => 0, 'planned' => []];
        if ($account->status === 'revoked') {
            return ['reason' => 'revoked'] + $out;
        }
        if (! $this->policy->mayPushNow($account)) {
            return ['reason' => 'not_allowed'] + $out;
        }
        $lock = $dry ? null : Cache::lock("calendar-write:{$account->id}", 60);
        if ($lock && ! $lock->get()) {
            return ['reason' => 'busy'] + $out;
        }
        $run = $dry ? null : SyncRun::create(['user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'trigger' => $trigger, 'started_at' => now(), 'status' => 'running', 'mode' => 'incremental']);
        $status = 'success';
        $error = null;
        try {
            $links = CalendarWriteLink::where('calendar_account_id', $account->id)->whereNotNull('calendar_event_id')->with('event')->orderBy('id')->get()
                ->filter(fn (CalendarWriteLink $l) => $l->event && ! $l->inSync())->values();
            $out['pending'] = $links->count();
            $open = SyncConflict::where('calendar_account_id', $account->id)->where('status', SyncConflict::OPEN)->pluck('calendar_write_link_id')->all();
            foreach ($links->take(self::BATCH) as $link) {
                if (in_array($link->id, $open, true)) {
                    $out['awaiting']++;

                    continue;
                }
                if ($dry) {
                    $out['planned'][] = ['link_id' => $link->id, 'event_id' => $link->calendar_event_id, 'from' => $link->title, 'to' => $link->event->title];

                    continue;
                }
                try {
                    $this->writes->pushUpdate($account, $link, $link->event);
                    $out['pushed']++;
                } catch (CalendarWriteException $e) {
                    if ($e->reason === 'changed') {
                        // Found now; the person's standing policy may settle it, otherwise it waits for them (and nothing is sent for this copy meanwhile).
                        $out['conflicts']++;
                        if ($this->conflicts->applyPolicy($account, $link, $link->event) === 'open') {
                            $out['awaiting']++;
                        }
                    } elseif ($e->reason === 'gone') {
                        // The copy was removed at the service by somebody else: forget our link so it can be added again if wanted. Nothing is deleted anywhere.
                        $link->delete();
                        $out['gone']++;
                    } elseif ($e->reason === 'rate_limited') {
                        $account->forceFill(['retry_after' => now()->addSeconds(max(30, $e->retryAfter))])->save();
                        $status = 'rate_limited';
                        $error = $e->getMessage();
                        break;
                    } else {
                        $out['failed']++;
                        $error = $e->getMessage();
                    }
                } catch (ProviderAuthException $e) {
                    $this->sync->markRevoked($account, $e->getMessage());
                    $status = 'revoked';
                    $error = $e->getMessage();
                    break;
                } catch (PermissionDeniedException $e) {
                    // The person changed their mind while this ran: stop, send nothing more.
                    $out['reason'] = $e->reason;
                    break;
                } catch (RateLimitedException $e) {
                    // The token refresh (not the write) was rate-limited: wait as for a rate-limited write, send nothing more.
                    $account->forceFill(['retry_after' => now()->addSeconds(max(30, $e->retryAfter))])->save();
                    $status = 'rate_limited';
                    $error = SecretRedactor::scrub($e->getMessage());
                    break;
                } catch (ProviderException $e) {
                    // The token refresh failed for a reason that is not revoked access (outage, 5xx, malformed answer): the run fails and stops; the account is neither revoked nor notified about.
                    $out['failed']++;
                    $status = $out['pushed'] > 0 ? 'partial' : 'failed';
                    $error = SecretRedactor::scrub($e->getMessage());
                    break;
                }
            }
            if ($out['failed'] > 0 && $status === 'success') {
                $status = $out['pushed'] > 0 ? 'partial' : 'failed';
            }
        } finally {
            $lock?->release();
        }
        $out['ran'] = true;
        $run?->forceFill(['upserted' => $out['pushed'], 'removed' => 0, 'moved' => 0, 'details' => ['pushed' => $out['pushed'], 'conflicts' => $out['conflicts'], 'awaiting' => $out['awaiting'], 'gone' => $out['gone'], 'failed' => $out['failed'], 'pending' => $out['pending']]])
            ->finish($status, $error);

        return $out;
    }
}
