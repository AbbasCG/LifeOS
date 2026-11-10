<?php

namespace App\Services;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\CalendarWriteException;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\WritableCalendar;
use App\Integrations\Permissions\ConnectionPermissions;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\User;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * Opt-in write-back to Google Calendar and Outlook.
 *
 * Nothing is ever written automatically. Each change is previewed first; the preview returns a single-use, encrypted
 * token describing exactly that change, and only confirming that token performs it — after re-checking that nothing
 * changed in between. LifeOS only creates copies of its own events and only updates or removes copies it created
 * (tracked in calendar_write_links), guarded by the provider's etag so edits made there are never overwritten.
 */
class CalendarWriteService
{
    public const OPS = ['create', 'update', 'delete'];

    public function __construct(private CalendarProviders $providers, private CalendarSyncService $sync, private AuditLogger $audit, private ConnectionPermissions $permissions) {}

    public function featureEnabled(): bool
    {
        return (bool) config('calendar_write.enabled');
    }

    public function writer(CalendarAccount $account): ?WritableCalendar
    {
        $provider = $this->providers->get($account->provider);

        return $this->featureEnabled() && $provider instanceof WritableCalendar && $provider->isConfigured() ? $provider : null;
    }

    /**
     * What the hub shows about writing for one account. Never includes tokens. The hub passes the copy count it already fetched for all accounts.
     *
     * @return array{available: bool, granted: bool, enabled: bool, calendar_id: ?string, calendar_name: ?string, copies: int}
     */
    public function state(CalendarAccount $account, ?int $copies = null): array
    {
        $available = $this->writer($account) !== null && $account->status !== 'revoked';

        return [
            'available' => $available,
            'granted' => $account->write_granted_at !== null,
            'enabled' => $available && $account->write_granted_at !== null && $account->write_calendar_id !== null,
            'calendar_id' => $account->write_calendar_id,
            'calendar_name' => $account->write_calendar_name,
            'copies' => $copies ?? CalendarWriteLink::where('calendar_account_id', $account->id)->count(),
        ];
    }

    /**
     * Bring one existing copy up to date with its LifeOS event, for the outbound synchronisation and for resolving a conflict. The same guards as a confirmed change: the writer must be
     * available, the person must have allowed `update`, and the provider's etag is sent so an edit made at the service is never overwritten - unless the caller was told, by the
     * person's policy or choice, to overwrite ($overwrite sends no etag). Throws CalendarWriteException / ProviderAuthException / PermissionDeniedException; the caller decides what to record.
     */
    public function pushUpdate(CalendarAccount $account, CalendarWriteLink $link, CalendarEvent $event, bool $overwrite = false): CalendarWriteLink
    {
        $this->permissions->authorize($account, ConnectionPermissions::UPDATE);
        $writer = $this->writer($account) ?? throw new CalendarWriteException('denied', 'Adding events is not available for this account.');
        $result = $writer->updateEvent($this->sync->freshToken($account), $link->calendar_id, $link->external_id, $overwrite ? null : $link->etag, $event->title, $event->starts_at, $event->ends_at);
        $link->forceFill(['etag' => $result['etag'], 'title' => $event->title, 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at])->save();

        return $link;
    }

    /**
     * Add a NEW copy of a LifeOS event (used by "keep both"): needs `create` and a chosen calendar. The copy is made at the service FIRST; only when that worked is the link
     * to the copy it replaces swapped for the new one, in one transaction (one LifeOS event has one link per account), so a failure at the service leaves everything as it was.
     */
    public function pushCreate(CalendarAccount $account, CalendarEvent $event, ?CalendarWriteLink $replacing = null): CalendarWriteLink
    {
        $this->permissions->authorize($account, ConnectionPermissions::CREATE);
        $writer = $this->writer($account);
        if (! $writer || $account->write_calendar_id === null) {
            throw new CalendarWriteException('denied', 'Pick a calendar to add events to first.');
        }
        $result = $writer->createEvent($this->sync->freshToken($account), $account->write_calendar_id, 'lifeos'.bin2hex(random_bytes(12)), $event->title, $event->starts_at, $event->ends_at);

        return DB::transaction(function () use ($account, $event, $result, $replacing) {
            $replacing?->delete();

            return CalendarWriteLink::create(['user_id' => $account->user_id, 'calendar_account_id' => $account->id, 'calendar_event_id' => $event->id, 'calendar_id' => $account->write_calendar_id,
                'external_id' => $result['id'], 'etag' => $result['etag'], 'title' => $event->title, 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at]);
        });
    }

    /**
     * Describe one change without making it, and return the token that confirms exactly this change.
     *
     * @param  array{op: string, account_id: int, event_id?: int|null, link_id?: int|null}  $input
     * @return array<string, mixed>
     */
    public function preview(User $user, array $input): array
    {
        [$account, $event, $link] = $this->resolve($user, $input['op'], (int) $input['account_id'], $input['event_id'] ?? null, $input['link_id'] ?? null);
        $nonce = Str::random(32);
        $clientId = $input['op'] === 'create' ? 'lifeos'.bin2hex(random_bytes(12)) : null;
        $expires = now()->addMinutes((int) config('calendar_write.preview_minutes', 10));
        $token = Crypt::encryptString(json_encode([
            'u' => $user->id, 'op' => $input['op'], 'a' => $account->id, 'e' => $event?->id, 'l' => $link?->id,
            'h' => $this->fingerprint($account, $event, $link), 'n' => $nonce, 'c' => $clientId, 'x' => $expires->getTimestamp(),
        ]) ?: '');
        Cache::put("calendar-write-preview:{$nonce}", $user->id, $expires);
        $label = $this->providers->get($account->provider)?->label() ?? $account->provider;
        $state = fn (?object $o) => $o ? ['title' => $o->title, 'starts_at' => $o->starts_at->toIso8601String(), 'ends_at' => $o->ends_at->toIso8601String()] : null;

        return [
            'op' => $input['op'],
            'account' => ['id' => $account->id, 'provider' => $account->provider, 'label' => $label, 'email' => $account->email],
            'calendar' => ['id' => $account->write_calendar_id, 'name' => $account->write_calendar_name],
            'before' => $input['op'] === 'create' ? null : $state($link),
            'after' => $input['op'] === 'delete' ? null : $state($event),
            'token' => $token,
            'expires_at' => $expires->toIso8601String(),
        ];
    }

    /**
     * Perform a previewed change. Single use; refused if anything changed since the preview.
     *
     * @return array{op: string, link: array<string, mixed>|null}
     */
    public function confirm(User $user, string $token, ?Request $request = null): array
    {
        try {
            $data = json_decode(Crypt::decryptString($token), true, flags: JSON_THROW_ON_ERROR);
        } catch (DecryptException|\JsonException) {
            throw ValidationException::withMessages(['token' => ['This preview is not valid. Preview the change again.']]);
        }
        if (($data['u'] ?? null) !== $user->id || ($data['x'] ?? 0) < now()->getTimestamp() || Cache::pull("calendar-write-preview:{$data['n']}") !== $user->id) {
            throw ValidationException::withMessages(['token' => ['This preview has expired or was already used. Preview the change again.']]);
        }
        [$account, $event, $link] = $this->resolve($user, $data['op'], (int) $data['a'], $data['e'], $data['l']);
        if (! hash_equals($data['h'], $this->fingerprint($account, $event, $link))) {
            throw new HttpException(409, 'Something changed since the preview. Review the change again.');
        }
        $writer = $this->writer($account);
        $lock = Cache::lock("calendar-write:{$account->id}", 30);
        if (! $lock->get()) {
            throw new HttpException(409, 'Another change to this calendar is in progress. Try again in a moment.');
        }
        $meta = ['op' => $data['op'], 'provider' => $account->provider, 'account_id' => $account->id, 'event_id' => $event?->id, 'link_id' => $link?->id];
        try {
            $accessToken = $this->sync->freshToken($account);
            $result = match ($data['op']) {
                'create' => $writer->createEvent($accessToken, $account->write_calendar_id, $data['c'], $event->title, $event->starts_at, $event->ends_at),
                'update' => $writer->updateEvent($accessToken, $link->calendar_id, $link->external_id, $link->etag, $event->title, $event->starts_at, $event->ends_at),
                'delete' => $writer->deleteEvent($accessToken, $link->calendar_id, $link->external_id, $link->etag),
            };
        } catch (ProviderAuthException $e) {
            $this->sync->markRevoked($account, $e->getMessage());
            $this->audit->log($user, 'calendar_write_failed', $request, $meta + ['reason' => 'revoked']);
            throw ValidationException::withMessages(['account' => [$e->getMessage().' Reconnect it — nothing was changed.']]);
        } catch (CalendarWriteException $e) {
            if ($e->reason === 'gone' && $link) {
                // The copy was deleted there: forget it, so it can be added again if wanted.
                $link->delete();
            }
            $this->audit->log($user, 'calendar_write_failed', $request, $meta + ['reason' => $e->reason]);
            throw ValidationException::withMessages(['calendar' => [$e->getMessage()]]);
        } finally {
            $lock->release();
        }

        $saved = match ($data['op']) {
            'create' => CalendarWriteLink::create(['user_id' => $user->id, 'calendar_account_id' => $account->id, 'calendar_event_id' => $event->id, 'calendar_id' => $account->write_calendar_id,
                'external_id' => $result['id'], 'etag' => $result['etag'], 'title' => $event->title, 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at]),
            'update' => tap($link)->update(['etag' => $result['etag'], 'title' => $event->title, 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at]),
            'delete' => tap(null, fn () => $link->delete()),
        };
        $this->audit->log($user, 'calendar_write', $request, $meta + ['link_id' => $saved?->id ?? $link?->id]);

        return ['op' => $data['op'], 'link' => $saved?->fresh()?->present()];
    }

    /**
     * Load and validate everything a change touches, for preview and again for confirmation.
     *
     * @return array{0: CalendarAccount, 1: ?CalendarEvent, 2: ?CalendarWriteLink}
     */
    private function resolve(User $user, string $op, int $accountId, ?int $eventId, ?int $linkId): array
    {
        $fail = fn (string $field, string $message) => throw ValidationException::withMessages([$field => [$message]]);
        if (! in_array($op, self::OPS, true)) {
            $fail('op', 'Unknown change.');
        }
        if (! $this->featureEnabled()) {
            $fail('calendar', 'Adding events to connected calendars is turned off on this server.');
        }
        $account = CalendarAccount::where('user_id', $user->id)->find($accountId) ?? $fail('account_id', 'Choose one of your connected calendars.');
        // What the person allowed for THIS connection, checked here for the preview and again for the confirmation (it may have changed in between). The provider's token is not the
        // protection: a broad write scope would still let Delete through at the provider, so LifeOS refuses before it ever asks.
        $this->permissions->authorize($account, $op);
        $state = $this->state($account);
        if (! $state['enabled']) {
            $fail('account_id', 'Adding events is not turned on for this account. Allow it and pick a calendar in Connected accounts first.');
        }
        $event = $eventId ? (CalendarEvent::where('user_id', $user->id)->find($eventId) ?? $fail('event_id', 'This LifeOS event no longer exists.')) : null;
        $link = $linkId
            ? (CalendarWriteLink::where('user_id', $user->id)->where('calendar_account_id', $account->id)->find($linkId) ?? $fail('link_id', 'LifeOS did not add this event, so it cannot change it.'))
            : ($event ? CalendarWriteLink::where('calendar_account_id', $account->id)->where('calendar_event_id', $event->id)->first() : null);
        match ($op) {
            'create' => match (true) {
                ! $event => $fail('event_id', 'Choose a LifeOS event.'),
                $event->isRecurring() => $fail('event_id', 'Repeating events cannot be added yet — only single events.'),
                $link !== null => $fail('event_id', 'This event was already added to that calendar. Update or remove the copy instead.'),
                default => null,
            },
            'update' => match (true) {
                ! $link || ! $event => $fail('event_id', 'There is no copy of this event to update.'),
                $link->inSync() => $fail('event_id', 'The copy already matches this event.'),
                default => null,
            },
            'delete' => $link ?? $fail('link_id', 'There is no copy to remove.'),
        };

        return [$account, $event, $link];
    }

    /** Everything a confirmation depends on; any change between preview and confirm invalidates it. */
    private function fingerprint(CalendarAccount $account, ?CalendarEvent $event, ?CalendarWriteLink $link): string
    {
        return hash('sha256', json_encode([
            $account->id, $account->write_calendar_id, $account->status,
            $event ? [$event->id, $event->title, $event->starts_at->getTimestamp(), $event->ends_at->getTimestamp()] : null,
            $link ? [$link->id, $link->external_id, $link->etag, $link->starts_at->getTimestamp(), $link->ends_at->getTimestamp(), $link->title] : null,
        ]) ?: '');
    }
}
