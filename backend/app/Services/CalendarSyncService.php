<?php

namespace App\Services;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\ChangeSet;
use App\Integrations\Calendar\ConnectedProvider;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\ProviderException;
use App\Integrations\Calendar\RateLimitedException;
use App\Integrations\Calendar\SyncTokenExpiredException;
use App\Integrations\Tasks\TaskProvider;
use App\Models\CalendarAccount;
use App\Models\ExternalEvent;
use App\Models\ExternalTask;
use App\Models\SyncRun;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * One-way, read-only import of external commitments and tasks. Never writes to the provider.
 *
 * Collections (calendars or task lists) follow the user's choice: accounts connected since selection existed start with
 * only the primary collection included ("collections" = [] until first loaded); accounts from before keep their
 * previous behaviour ("collections" = null → the provider's default set) until the user changes the selection.
 *
 * Reliability: one sync per account at a time (cache lock); incremental reads with provider sync tokens / delta links,
 * a full re-read at least daily and whenever a token expires; rate limits honour Retry-After; each collection is
 * applied in its own transaction so one failing calendar does not discard the others (partial sync); every attempt is
 * recorded in sync_runs with counts and an actionable error.
 */
class CalendarSyncService
{
    public const PAST_DAYS = 7;

    public const FUTURE_DAYS = 90;

    /** A full re-read refreshes the moving window and catches anything an incremental token could miss. */
    public const FULL_SYNC_HOURS = 24;

    /** Completed external tasks stay visible this long, then are dropped. */
    public const COMPLETED_TASK_DAYS = 7;

    public function __construct(private CalendarProviders $providers, private AuditLogger $audit) {}

    /**
     * Refresh the access token if it expires within two minutes.
     */
    public function freshToken(CalendarAccount $account): string
    {
        if ($account->token_expires_at && $account->token_expires_at->isAfter(now()->addMinutes(2))) {
            return $account->access_token;
        }
        if (! $account->token_expires_at && ! $account->refresh_token) {
            // Non-expiring access tokens (e.g. Todoist).
            return $account->access_token;
        }
        if (! $account->refresh_token) {
            throw new ProviderAuthException('No refresh token is available. Reconnect the account.');
        }
        $tokens = $this->providers->get($account->provider)->refresh($account->refresh_token);
        $account->forceFill([
            'access_token' => $tokens->accessToken,
            'refresh_token' => $tokens->refreshToken ?? $account->refresh_token,
            'token_expires_at' => $tokens->expiresAt,
        ])->save();

        return $tokens->accessToken;
    }

    /**
     * Whether a scheduled sync should run now: never for revoked or under-scoped accounts, not before Retry-After, and
     * with exponential back-off after three consecutive failures (1h, 2h, 4h … capped at 6h).
     */
    public function due(CalendarAccount $account): bool
    {
        if ($account->status === 'revoked' || $account->scopes_ok === false) {
            return false;
        }
        if ($account->retry_after && $account->retry_after->isFuture()) {
            return false;
        }
        if ($account->consecutive_failures >= 3 && $account->last_attempt_at) {
            $wait = (int) min(360, 60 * 2 ** ($account->consecutive_failures - 3));

            return $account->last_attempt_at->addMinutes($wait)->isPast();
        }

        return true;
    }

    /**
     * Import the selected collections. Returns the number of upserted items.
     *
     * @throws ProviderException when a transient failure should be retried (RateLimitedException carries the delay)
     */
    public function sync(CalendarAccount $account, string $trigger = 'scheduled'): int
    {
        if ($account->status === 'revoked' || $account->scopes_ok === false) {
            return 0;
        }
        $provider = $this->providers->get($account->provider);
        if (! $provider || ! $provider->isConfigured()) {
            $account->forceFill(['status' => 'error', 'last_error' => 'This provider is not configured on the server.'])->save();

            return 0;
        }
        if ($account->retry_after && $account->retry_after->isFuture()) {
            throw new RateLimitedException($provider->label().' asked LifeOS to slow down. Sync will resume automatically.', max(1, (int) now()->diffInSeconds($account->retry_after)));
        }
        $lock = Cache::lock("connected-sync:{$account->id}", 300);
        if (! $lock->get()) {
            // Another sync for this account is running; it will bring the data up to date.
            return 0;
        }
        $run = SyncRun::create(['user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'trigger' => $trigger, 'started_at' => now(), 'status' => 'running']);
        $account->forceFill(['last_attempt_at' => now()])->save();
        try {
            $token = $this->freshToken($account);
            $this->refreshCollections($account, $provider, $token);
            $result = $this->importCollections($account, $provider, $token);
        } catch (ProviderAuthException $e) {
            $run->finish('revoked', $e->getMessage());
            $this->markRevoked($account, $e->getMessage());

            return 0;
        } catch (RateLimitedException $e) {
            $run->finish('rate_limited', $e->getMessage());
            $account->forceFill(['status' => 'error', 'last_error' => $e->getMessage(), 'retry_after' => now()->addSeconds($e->retryAfter), 'consecutive_failures' => $account->consecutive_failures + 1])->save();

            throw $e;
        } catch (ProviderException $e) {
            $run->finish('failed', $e->getMessage());
            $account->forceFill(['status' => 'error', 'last_error' => mb_substr($e->getMessage(), 0, 500), 'consecutive_failures' => $account->consecutive_failures + 1])->save();

            throw $e;
        } finally {
            $lock->release();
        }

        $failed = $result['failed'];
        $count = $provider instanceof TaskProvider ? ExternalTask::where('calendar_account_id', $account->id)->count() : ExternalEvent::where('calendar_account_id', $account->id)->count();
        $status = $failed === [] ? 'success' : ($result['ok'] > 0 ? 'partial' : 'failed');
        $error = $failed === [] ? null : mb_substr('Could not read '.implode(', ', array_keys($failed)).'. '.implode(' ', array_unique($failed)), 0, 500);
        $run->forceFill(['mode' => $result['mode'], 'upserted' => $result['upserted'], 'removed' => $result['removed'], 'moved' => $result['moved'], 'details' => $result['details']])->finish($status, $error);
        $account->forceFill([
            'status' => $status === 'success' ? 'active' : 'error',
            'last_error' => $error,
            'last_synced_at' => $status === 'failed' ? $account->last_synced_at : now(),
            'events_count' => $count,
            'consecutive_failures' => $status === 'failed' ? $account->consecutive_failures + 1 : 0,
            'retry_after' => null,
        ])->save();
        if ($status === 'failed') {
            throw new ProviderException($error ?? 'Sync failed.');
        }

        return $result['upserted'];
    }

    /**
     * Load the provider's calendars or lists and merge them with the user's choices. New collections are excluded until
     * the user includes them; the first load of a new account includes only the primary one. Data and sync tokens of
     * collections that are no longer included (or no longer exist) are removed.
     */
    public function refreshCollections(CalendarAccount $account, ConnectedProvider $provider, string $token): void
    {
        $current = $account->collections;
        $available = $provider->collections($token);
        $known = collect($current ?? [])->keyBy('id');
        $first = $current === [] || ($current === null && $provider instanceof TaskProvider);
        $merged = array_map(fn (array $c) => [
            'id' => $c['id'], 'name' => $c['name'], 'color' => $c['color'], 'primary' => $c['primary'],
            'included' => $known->has($c['id']) ? (bool) $known[$c['id']]['included'] : ($first ? $c['primary'] : ($current === null ? $c['default_included'] : false)),
        ], $available);
        $included = collect($merged)->where('included', true)->pluck('id')->values()->all();
        $account->forceFill(['collections' => $merged, 'sync_state' => array_intersect_key($account->sync_state ?? [], array_flip($included)) ?: null])->save();
        $column = $provider instanceof TaskProvider ? 'list_id' : 'calendar_id';
        $model = $provider instanceof TaskProvider ? ExternalTask::query() : ExternalEvent::query();
        $model->where('calendar_account_id', $account->id)->where(fn ($q) => $q->whereNull($column)->orWhereNotIn($column, $included ?: ['__none__']))->delete();
    }

    /**
     * @return list<string>
     */
    private function includedIds(CalendarAccount $account): array
    {
        return collect($account->collections ?? [])->where('included', true)->pluck('id')->values()->all();
    }

    /**
     * Read and apply every included collection. Auth and rate-limit errors abort the whole sync; other errors are
     * recorded per collection so the rest still update.
     *
     * @return array{ok: int, failed: array<string, string>, upserted: int, removed: int, moved: int, mode: string, details: array<string, mixed>}
     */
    private function importCollections(CalendarAccount $account, ConnectedProvider $provider, string $token): array
    {
        $names = collect($account->collections ?? [])->pluck('name', 'id');
        $state = $account->sync_state ?? [];
        $result = ['ok' => 0, 'failed' => [], 'upserted' => 0, 'removed' => 0, 'moved' => 0, 'mode' => 'incremental', 'details' => ['cancelled' => [], 'moved' => []]];
        $from = CarbonImmutable::now()->subDays(self::PAST_DAYS)->startOfDay();
        $to = CarbonImmutable::now()->addDays(self::FUTURE_DAYS)->endOfDay();
        $tz = $account->user->timezone();
        $read = fn (?string $syncToken, string $collection) => $provider instanceof TaskProvider ? $provider->taskChanges($token, $collection, $syncToken, $tz) : $provider->changes($token, $collection, $syncToken, $from, $to, $tz);
        foreach ($this->includedIds($account) as $collection) {
            $previous = $state[$collection] ?? null;
            $stale = ! ($previous['token'] ?? null) || CarbonImmutable::parse($previous['full_at'] ?? '2000-01-01')->addHours(self::FULL_SYNC_HOURS)->isPast();
            try {
                try {
                    $changes = $read($stale ? null : $previous['token'], $collection);
                } catch (SyncTokenExpiredException) {
                    $changes = $read(null, $collection);
                }
            } catch (ProviderAuthException|RateLimitedException $e) {
                $account->forceFill(['sync_state' => $state ?: null])->save();

                throw $e;
            } catch (ProviderException $e) {
                $result['failed'][$names[$collection] ?? $collection] = $e->getMessage();

                continue;
            }
            $applied = $provider instanceof TaskProvider ? $this->applyTasks($account, $collection, $names[$collection] ?? null, $changes) : $this->applyEvents($account, $collection, $changes, $from, $to);
            $state[$collection] = ['token' => $changes->nextToken, 'full_at' => $changes->full ? now()->toIso8601String() : ($previous['full_at'] ?? now()->toIso8601String())];
            if ($changes->full) {
                $result['mode'] = 'full';
            }
            $result['ok']++;
            foreach (['upserted', 'removed', 'moved'] as $key) {
                $result[$key] += $applied[$key];
            }
            $result['details']['cancelled'] = array_slice([...$result['details']['cancelled'], ...$applied['cancelled']], 0, 10);
            $result['details']['moved'] = array_slice([...$result['details']['moved'], ...$applied['moved_items']], 0, 10);
        }
        $account->forceFill(['sync_state' => $state ?: null])->save();

        return $result;
    }

    /**
     * @return array{upserted: int, removed: int, moved: int, cancelled: list<array<string, string>>, moved_items: list<array<string, string>>}
     */
    private function applyEvents(CalendarAccount $account, string $calendarId, ChangeSet $changes, CarbonImmutable $from, CarbonImmutable $to): array
    {
        return DB::transaction(function () use ($account, $calendarId, $changes, $from, $to) {
            $existing = ExternalEvent::where('calendar_account_id', $account->id)->where('calendar_id', $calendarId)->get(['external_id', 'starts_at', 'previous_starts_at', 'changed_at'])->keyBy('external_id');
            $rows = [];
            $moved = [];
            foreach ($changes->upserts as $event) {
                if ($event['ends_at'] <= $event['starts_at']) {
                    continue;
                }
                $old = $existing->get($event['id']);
                $wasMoved = $old && ! $old->starts_at->equalTo($event['starts_at']);
                if ($wasMoved) {
                    $moved[] = ['title' => $event['title'], 'from' => $old->starts_at->toIso8601String(), 'to' => $event['starts_at']->toIso8601String()];
                }
                $rows[$event['id']] = [
                    'user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'external_id' => $event['id'], 'calendar_id' => $event['calendar_id'],
                    'title' => $event['title'], 'starts_at' => $event['starts_at'], 'ends_at' => $event['ends_at'], 'all_day' => $event['all_day'], 'show_as' => $event['show_as'],
                    'ical_uid' => $event['ical_uid'] ?? null, 'series_id' => $event['series_id'] ?? null, 'original_start' => $event['original_start'] ?? null,
                    'timezone' => isset($event['timezone']) ? mb_substr((string) $event['timezone'], 0, 64) : null,
                    'previous_starts_at' => $wasMoved ? $old->starts_at : $old?->previous_starts_at, 'changed_at' => $wasMoved ? now() : $old?->changed_at,
                    'created_at' => now(), 'updated_at' => now(),
                ];
            }
            foreach (array_chunk(array_values($rows), 200) as $chunk) {
                ExternalEvent::upsert($chunk, ['calendar_account_id', 'external_id'], ['calendar_id', 'title', 'starts_at', 'ends_at', 'all_day', 'show_as', 'ical_uid', 'series_id', 'original_start', 'timezone', 'previous_starts_at', 'changed_at', 'updated_at']);
            }
            $scope = fn () => ExternalEvent::where('calendar_account_id', $account->id)->where('calendar_id', $calendarId);
            // A full read is authoritative for the window; an incremental read lists what was deleted or cancelled.
            $gone = $changes->full
                ? $scope()->where('ends_at', '>', $from)->where('starts_at', '<', $to)->whereNotIn('external_id', array_keys($rows) ?: ['__none__'])
                : $scope()->whereIn('external_id', $changes->removed ?: ['__none__']);
            $cancelled = (clone $gone)->where('starts_at', '>', now())->orderBy('starts_at')->limit(10)->get(['title', 'starts_at'])->map(fn (ExternalEvent $e) => ['title' => $e->title, 'at' => $e->starts_at->toIso8601String()])->all();
            $removed = $gone->delete();
            // Drop history older than the window.
            $scope()->where('ends_at', '<', $from)->delete();

            return ['upserted' => count($rows), 'removed' => $removed, 'moved' => count($moved), 'cancelled' => $cancelled, 'moved_items' => $moved];
        });
    }

    /**
     * @return array{upserted: int, removed: int, moved: int, cancelled: list<array<string, string>>, moved_items: list<array<string, string>>}
     */
    private function applyTasks(CalendarAccount $account, string $listId, ?string $listName, ChangeSet $changes): array
    {
        return DB::transaction(function () use ($account, $listId, $listName, $changes) {
            $rows = [];
            $dropped = [];
            foreach ($changes->upserts as $task) {
                // Long-completed tasks are not worth keeping.
                if (($task['status'] ?? 'open') === 'completed' && ($task['completed_at'] ?? null) && $task['completed_at'] < now()->subDays(self::COMPLETED_TASK_DAYS)) {
                    $dropped[] = $task['id'];

                    continue;
                }
                $rows[$task['id']] = [
                    'user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'external_id' => $task['id'], 'list_id' => $task['list_id'],
                    'list_name' => $listName, 'title' => $task['title'], 'due_at' => $task['due_at'], 'due_is_date' => $task['due_is_date'],
                    'priority' => $task['priority'], 'url' => $task['url'] ? mb_substr($task['url'], 0, 1000) : null,
                    'status' => $task['status'] ?? 'open', 'completed_at' => $task['completed_at'] ?? null, 'created_at' => now(), 'updated_at' => now(),
                ];
            }
            foreach (array_chunk(array_values($rows), 200) as $chunk) {
                ExternalTask::upsert($chunk, ['calendar_account_id', 'external_id'], ['list_id', 'list_name', 'title', 'due_at', 'due_is_date', 'priority', 'url', 'status', 'completed_at', 'updated_at']);
            }
            $scope = fn () => ExternalTask::where('calendar_account_id', $account->id)->where('list_id', $listId);
            $removed = ($changes->full
                ? $scope()->whereNotIn('external_id', array_keys($rows) ?: ['__none__'])
                : $scope()->whereIn('external_id', [...$changes->removed, ...$dropped] ?: ['__none__']))->delete();
            $scope()->where('status', 'completed')->where('completed_at', '<', now()->subDays(self::COMPLETED_TASK_DAYS))->delete();

            return ['upserted' => count($rows), 'removed' => $removed, 'moved' => 0, 'cancelled' => [], 'moved_items' => []];
        });
    }

    public function markRevoked(CalendarAccount $account, string $reason): void
    {
        $wasActive = $account->status !== 'revoked';
        $account->forceFill(['status' => 'revoked', 'last_error' => mb_substr($reason, 0, 500)])->save();
        if ($wasActive) {
            $label = $this->providers->get($account->provider)?->label() ?? $account->provider;
            $ar = ($account->user->preferences()['language'] ?? 'en') === 'ar';
            app(Notifier::class)->send($account->user, 'system', "integration:revoked:{$account->id}:".now()->toDateString(), $ar ? "انقطع الاتصال بـ {$label}. أعد الربط لمتابعة المزامنة." : "{$label} disconnected. Reconnect to keep syncing.", ['link' => '/settings/integrations', 'kind' => 'integration']);
            $this->audit->log($account->user, 'integration_revoked', null, ['provider' => $account->provider]);
        }
    }

    /**
     * Imported commitments as read-only calendar occurrences, each shown once.
     *
     * The same meeting often appears in several connected calendars (an invite in Google and Outlook). Matching prefers
     * stable identifiers — the iCalendar UID plus the occurrence's original start — and falls back to title + time only
     * when a provider gives no UID.
     *
     * @return iterable<array<string, mixed>>
     */
    public static function occurrences(int $userId, CarbonImmutable $from, CarbonImmutable $to): iterable
    {
        $events = ExternalEvent::query()
            ->join('calendar_accounts', 'calendar_accounts.id', '=', 'external_events.calendar_account_id')
            ->where('external_events.user_id', $userId)->where('calendar_accounts.status', '!=', 'revoked')
            ->where('external_events.ends_at', '>', $from)->where('external_events.starts_at', '<', $to)
            ->orderBy('external_events.calendar_account_id')->orderBy('external_events.id')
            ->get(['external_events.*', 'calendar_accounts.provider', 'calendar_accounts.email as account_email']);
        $seen = [];
        foreach ($events as $event) {
            $identity = self::identity($event);
            $key = self::fingerprint($event->title, $event->starts_at, $event->ends_at);
            if (isset($seen[$identity]) || isset($seen[$key])) {
                continue;
            }
            $seen[$identity] = $seen[$key] = true;
            yield [
                'id' => 'x'.$event->id,
                'event_id' => null,
                'source' => $event->provider,
                'title' => $event->title,
                'description' => null,
                'kind' => $event->show_as === 'tentative' ? 'flexible' : 'fixed',
                'task_id' => null,
                'starts_at' => $event->starts_at,
                'ends_at' => $event->ends_at,
                'recurring' => $event->series_id !== null,
                'occurrence_start' => null,
                'is_exception' => false,
                'recurrence' => null,
                'timezone' => $event->timezone,
                'remind_minutes' => null,
                'editable' => false,
                'all_day' => $event->all_day,
                'account_id' => $event->calendar_account_id,
                'account_label' => $event->account_email,
                'ical_uid' => $event->ical_uid,
                'moved_from' => $event->previous_starts_at?->toIso8601String(),
                'fingerprint' => $key,
            ];
        }
    }

    /**
     * Stable identity of one occurrence across calendars and providers: iCalUID + original (or actual) start.
     */
    public static function identity(ExternalEvent $event): string
    {
        return $event->ical_uid ? 'uid:'.mb_strtolower($event->ical_uid).'|'.($event->original_start ?? $event->starts_at)->utc()->getTimestamp() : 'row:'.$event->id;
    }

    /**
     * Identity used to recognise the same commitment from different sources when no UID is available.
     */
    public static function fingerprint(string $title, CarbonImmutable $start, CarbonImmutable $end): string
    {
        return mb_strtolower(trim(preg_replace('/\s+/u', ' ', $title))).'|'.$start->utc()->getTimestamp().'|'.$end->utc()->getTimestamp();
    }
}
