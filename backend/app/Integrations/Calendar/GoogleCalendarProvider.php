<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Http;

class GoogleCalendarProvider extends OAuthProvider implements CalendarProvider
{
    public const SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar.readonly';

    public function name(): string
    {
        return 'google';
    }

    public function label(): string
    {
        return 'Google Calendar';
    }

    public function category(): string
    {
        return 'calendar';
    }

    public function scopeSummary(): string
    {
        return 'Read-only access to your calendars and events (calendar.readonly), plus your name and email address.';
    }

    public function envKeys(): array
    {
        return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
    }

    protected function configKey(): string
    {
        return 'google_calendar';
    }

    protected function tokenUrl(): string
    {
        return 'https://oauth2.googleapis.com/token';
    }

    public function authorizationUrl(string $state, string $codeChallenge): string
    {
        return 'https://accounts.google.com/o/oauth2/v2/auth?'.http_build_query([
            'client_id' => $this->config()['client_id'],
            'redirect_uri' => $this->config()['redirect'],
            'response_type' => 'code',
            'scope' => self::SCOPES,
            'access_type' => 'offline',
            'prompt' => 'consent',
            'include_granted_scopes' => 'true',
            'state' => $state,
            'code_challenge' => $codeChallenge,
            'code_challenge_method' => 'S256',
        ]);
    }

    public function account(string $accessToken): array
    {
        $profile = $this->send(fn () => $this->http($accessToken)->get('https://openidconnect.googleapis.com/v1/userinfo'))->json();

        return ['id' => (string) $profile['sub'], 'email' => $profile['email'] ?? null, 'name' => $profile['name'] ?? null];
    }

    /**
     * @return list<array<string, mixed>>
     */
    /** @var array<string, list<array<string, mixed>>> calendar list per access token, so one sync reads it once */
    private array $calendarLists = [];

    private function calendarList(string $accessToken): array
    {
        $key = hash('sha256', $accessToken);
        if (count($this->calendarLists) > 20) {
            $this->calendarLists = [];
        }

        return $this->calendarLists[$key] ??= $this->send(fn () => $this->http($accessToken)->get('https://www.googleapis.com/calendar/v3/users/me/calendarList', ['minAccessRole' => 'reader', 'maxResults' => 250]))->json('items') ?? [];
    }

    public function collections(string $accessToken): array
    {
        $list = $this->calendarList($accessToken);
        $hasPrimary = collect($list)->contains(fn (array $c) => ($c['primary'] ?? false) === true);

        return array_values(array_map(fn (array $c, int $i) => [
            'id' => (string) $c['id'],
            'name' => mb_substr((string) ($c['summaryOverride'] ?? $c['summary'] ?? $c['id']), 0, 200),
            'color' => $c['backgroundColor'] ?? null,
            'primary' => ($c['primary'] ?? false) === true || (! $hasPrimary && $i === 0),
            'default_included' => ($c['selected'] ?? true) !== false && ! ($c['hidden'] ?? false),
        ], $list, array_keys($list)));
    }

    public function requiredScopes(): array
    {
        return ['calendar.readonly'];
    }

    public function changes(string $accessToken, string $calendarId, ?string $syncToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): ChangeSet
    {
        $calendarZone = collect($this->calendarList($accessToken))->firstWhere('id', $calendarId)['timeZone'] ?? $userTimezone;
        // Full sync: everything from the window start (Google's sync tokens cannot be combined with timeMin/timeMax later).
        // Incremental: only changes since the token, including deletions (status "cancelled").
        $params = $syncToken !== null ? ['syncToken' => $syncToken] : ['timeMin' => $from->toIso8601ZuluString()];
        $upserts = [];
        $removed = [];
        $pageToken = null;
        $next = null;
        do {
            $page = $this->send(fn () => $this->http($accessToken)->get('https://www.googleapis.com/calendar/v3/calendars/'.rawurlencode($calendarId).'/events', array_filter($params + [
                'singleEvents' => 'true',
                'maxResults' => 2500,
                'pageToken' => $pageToken,
            ])))->json();
            foreach ($page['items'] ?? [] as $item) {
                $id = $calendarId.'|'.$item['id'];
                if (($item['status'] ?? '') === 'cancelled' || ($item['transparency'] ?? 'opaque') === 'transparent' || ! isset($item['start'])) {
                    $removed[] = $id;

                    continue;
                }
                $allDay = isset($item['start']['date']);
                $zone = $item['start']['timeZone'] ?? $calendarZone;
                $start = $allDay ? CarbonImmutable::parse($item['start']['date'], $zone)->startOfDay() : CarbonImmutable::parse($item['start']['dateTime']);
                $end = $allDay ? CarbonImmutable::parse($item['end']['date'], $zone)->startOfDay() : CarbonImmutable::parse($item['end']['dateTime']);
                if ($end <= $from || $start >= $to) {
                    // Outside the window (or moved out of it): not stored.
                    $removed[] = $id;

                    continue;
                }
                $original = $item['originalStartTime'] ?? null;
                $upserts[] = [
                    'id' => $id,
                    'calendar_id' => $calendarId,
                    'title' => mb_substr($item['summary'] ?? '(busy)', 0, 500),
                    'starts_at' => $start->utc(),
                    'ends_at' => $end->utc(),
                    'all_day' => $allDay,
                    'show_as' => 'busy',
                    'ical_uid' => isset($item['iCalUID']) ? mb_substr((string) $item['iCalUID'], 0, 1024) : null,
                    'series_id' => $item['recurringEventId'] ?? null,
                    'original_start' => $original ? (isset($original['date']) ? CarbonImmutable::parse($original['date'], $zone) : CarbonImmutable::parse($original['dateTime']))->utc() : null,
                    'timezone' => $zone,
                ];
            }
            $pageToken = $page['nextPageToken'] ?? null;
            $next = $page['nextSyncToken'] ?? $next;
        } while ($pageToken);

        return new ChangeSet($upserts, $removed, $next, $syncToken === null);
    }

    public function revoke(string $token): void
    {
        Http::asForm()->timeout(10)->post('https://oauth2.googleapis.com/revoke', ['token' => $token]);
    }
}
