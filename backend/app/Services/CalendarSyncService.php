<?php

namespace App\Services;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\ProviderException;
use App\Models\CalendarAccount;
use App\Models\ExternalEvent;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * One-way, read-only import of external commitments. Never writes to the provider.
 */
class CalendarSyncService
{
    public const PAST_DAYS = 7;

    public const FUTURE_DAYS = 90;

    public function __construct(private CalendarProviders $providers, private AuditLogger $audit) {}

    /**
     * Refresh the access token if it expires within two minutes.
     */
    public function freshToken(CalendarAccount $account): string
    {
        if ($account->token_expires_at && $account->token_expires_at->isAfter(now()->addMinutes(2))) {
            return $account->access_token;
        }
        if (! $account->refresh_token) {
            throw new ProviderAuthException('No refresh token is available. Reconnect the calendar.');
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
     * Import the sync window. Returns the number of stored events.
     *
     * @throws ProviderException when a transient failure should be retried
     */
    public function sync(CalendarAccount $account): int
    {
        if ($account->status === 'revoked') {
            return 0;
        }
        $provider = $this->providers->get($account->provider);
        if (! $provider || ! $provider->isConfigured()) {
            $account->forceFill(['status' => 'error', 'last_error' => 'This provider is not configured on the server.'])->save();

            return 0;
        }
        $from = CarbonImmutable::now()->subDays(self::PAST_DAYS)->startOfDay();
        $to = CarbonImmutable::now()->addDays(self::FUTURE_DAYS)->endOfDay();
        try {
            $token = $this->freshToken($account);
            $seen = [];
            $rows = [];
            foreach ($provider->events($token, $from, $to, $account->user->timezone()) as $event) {
                if ($event['ends_at'] <= $event['starts_at'] || isset($seen[$event['id']])) {
                    continue;
                }
                $seen[$event['id']] = true;
                $rows[] = [
                    'user_id' => $account->user_id,
                    'calendar_account_id' => $account->id,
                    'external_id' => $event['id'],
                    'calendar_id' => $event['calendar_id'],
                    'title' => $event['title'],
                    'starts_at' => $event['starts_at'],
                    'ends_at' => $event['ends_at'],
                    'all_day' => $event['all_day'],
                    'show_as' => $event['show_as'],
                    'created_at' => now(),
                    'updated_at' => now(),
                ];
            }
        } catch (ProviderAuthException $e) {
            $this->markRevoked($account, $e->getMessage());

            return 0;
        } catch (ProviderException $e) {
            $account->forceFill(['status' => 'error', 'last_error' => mb_substr($e->getMessage(), 0, 500)])->save();

            throw $e;
        }

        DB::transaction(function () use ($account, $rows, $from, $to) {
            foreach (array_chunk($rows, 200) as $chunk) {
                ExternalEvent::upsert($chunk, ['calendar_account_id', 'external_id'], ['calendar_id', 'title', 'starts_at', 'ends_at', 'all_day', 'show_as', 'updated_at']);
            }
            // Remove events in the window that no longer exist upstream.
            ExternalEvent::where('calendar_account_id', $account->id)
                ->where('ends_at', '>', $from)->where('starts_at', '<', $to)
                ->whereNotIn('external_id', array_column($rows, 'external_id') ?: ['__none__'])
                ->delete();
            // Drop history older than the window.
            ExternalEvent::where('calendar_account_id', $account->id)->where('ends_at', '<', $from)->delete();
            $account->forceFill(['status' => 'active', 'last_error' => null, 'last_synced_at' => now(), 'events_count' => ExternalEvent::where('calendar_account_id', $account->id)->count()])->save();
        });

        return count($rows);
    }

    public function markRevoked(CalendarAccount $account, string $reason): void
    {
        $wasActive = $account->status !== 'revoked';
        $account->forceFill(['status' => 'revoked', 'last_error' => mb_substr($reason, 0, 500)])->save();
        if ($wasActive) {
            $label = $account->provider === 'google' ? 'Google Calendar' : 'Outlook';
            $ar = ($account->user->preferences()['language'] ?? 'en') === 'ar';
            app(Notifier::class)->send($account->user, 'system', "integration:revoked:{$account->id}:".now()->toDateString(), $ar ? "انقطع الاتصال بـ {$label}. أعد الربط لمتابعة المزامنة." : "{$label} disconnected. Reconnect to keep syncing.", ['link' => '/settings/integrations', 'kind' => 'integration']);
            $this->audit->log($account->user, 'integration_revoked', null, ['provider' => $account->provider]);
        }
    }

    /**
     * Imported commitments as read-only calendar occurrences.
     *
     * @return iterable<array<string, mixed>>
     */
    public static function occurrences(int $userId, CarbonImmutable $from, CarbonImmutable $to): iterable
    {
        $events = ExternalEvent::query()
            ->join('calendar_accounts', 'calendar_accounts.id', '=', 'external_events.calendar_account_id')
            ->where('external_events.user_id', $userId)->where('calendar_accounts.status', '!=', 'revoked')
            ->where('external_events.ends_at', '>', $from)->where('external_events.starts_at', '<', $to)
            ->get(['external_events.*', 'calendar_accounts.provider', 'calendar_accounts.email as account_email']);
        foreach ($events as $event) {
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
                'recurring' => false,
                'occurrence_start' => null,
                'is_exception' => false,
                'recurrence' => null,
                'timezone' => null,
                'remind_minutes' => null,
                'editable' => false,
                'all_day' => $event->all_day,
                'account_label' => $event->account_email,
            ];
        }
    }
}
