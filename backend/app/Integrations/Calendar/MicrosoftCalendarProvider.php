<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

class MicrosoftCalendarProvider extends OAuthProvider implements CalendarProvider, WritableCalendar
{
    public const SCOPES = 'openid email profile offline_access User.Read Calendars.Read';

    /** Create, change and delete events in the user's calendars. Only requested when the user opts in. */
    public const WRITE_SCOPE = 'Calendars.ReadWrite';

    public function name(): string
    {
        return 'outlook';
    }

    public function label(): string
    {
        return 'Outlook Calendar';
    }

    protected function configKey(): string
    {
        return 'microsoft_calendar';
    }

    public function category(): string
    {
        return 'calendar';
    }

    public function scopeSummary(): string
    {
        return 'Read-only access to your calendars (Calendars.Read), your basic profile (User.Read) and offline access to keep syncing.';
    }

    public function envKeys(): array
    {
        return ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'MICROSOFT_REDIRECT_URI'];
    }

    public function collections(string $accessToken): array
    {
        $calendars = $this->send(fn () => $this->http($accessToken)->get('https://graph.microsoft.com/v1.0/me/calendars', ['$select' => 'id,name,hexColor,isDefaultCalendar', '$top' => 100]))->json('value') ?? [];

        return array_values(array_map(fn (array $c) => [
            'id' => (string) $c['id'], 'name' => mb_substr((string) ($c['name'] ?? 'Calendar'), 0, 200), 'color' => ($c['hexColor'] ?? '') ?: null,
            'primary' => (bool) ($c['isDefaultCalendar'] ?? false), 'default_included' => (bool) ($c['isDefaultCalendar'] ?? false),
        ], $calendars));
    }

    protected function tokenUrl(): string
    {
        return 'https://login.microsoftonline.com/'.rawurlencode($this->config()['tenant'] ?? 'common').'/oauth2/v2.0/token';
    }

    public function authorizationUrl(string $state, string $codeChallenge): string
    {
        return 'https://login.microsoftonline.com/'.rawurlencode($this->config()['tenant'] ?? 'common').'/oauth2/v2.0/authorize?'.http_build_query([
            'client_id' => $this->config()['client_id'],
            'redirect_uri' => $this->config()['redirect'],
            'response_type' => 'code',
            'response_mode' => 'query',
            'scope' => self::SCOPES,
            'state' => $state,
            'code_challenge' => $codeChallenge,
            'code_challenge_method' => 'S256',
            'prompt' => 'select_account',
        ]);
    }

    public function account(string $accessToken): array
    {
        $me = $this->send(fn () => $this->http($accessToken)->get('https://graph.microsoft.com/v1.0/me', ['$select' => 'id,displayName,mail,userPrincipalName']))->json();

        return ['id' => (string) $me['id'], 'email' => $me['mail'] ?? $me['userPrincipalName'] ?? null, 'name' => $me['displayName'] ?? null];
    }

    public function requiredScopes(): array
    {
        return ['Calendars.Read'];
    }

    public function changes(string $accessToken, string $calendarId, ?string $syncToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): ChangeSet
    {
        // calendarView/delta expands recurring series into occurrences inside the window and reports deletions with
        // "@removed"; the final page carries a deltaLink used as the token for the next incremental read.
        $url = $syncToken ?? 'https://graph.microsoft.com/v1.0/me/calendars/'.rawurlencode($calendarId).'/calendarView/delta?'.http_build_query([
            'startDateTime' => $from->toIso8601ZuluString(),
            'endDateTime' => $to->toIso8601ZuluString(),
        ]);
        if (! str_starts_with($url, 'https://graph.microsoft.com/')) {
            throw new SyncTokenExpiredException('Unexpected delta link.');
        }
        $upserts = [];
        $removed = [];
        $next = null;
        while ($url) {
            $page = $this->send(fn () => $this->http($accessToken)->withHeaders(['Prefer' => 'outlook.timezone="UTC", odata.maxpagesize=200'])->get($url))->json();
            foreach ($page['value'] ?? [] as $item) {
                $id = (string) $item['id'];
                if (isset($item['@removed']) || ($item['isCancelled'] ?? false) || in_array($item['showAs'] ?? 'busy', ['free', 'workingElsewhere'], true) || ! isset($item['start'])) {
                    $removed[] = $id;

                    continue;
                }
                $allDay = (bool) ($item['isAllDay'] ?? false);
                // With Prefer: outlook.timezone="UTC" Graph returns UTC wall times without an offset; all-day events are
                // midnight-to-midnight in the user's zone.
                $start = $allDay ? CarbonImmutable::parse(substr($item['start']['dateTime'], 0, 10), $userTimezone) : CarbonImmutable::parse($item['start']['dateTime'], 'UTC');
                $end = $allDay ? CarbonImmutable::parse(substr($item['end']['dateTime'], 0, 10), $userTimezone) : CarbonImmutable::parse($item['end']['dateTime'], 'UTC');
                $upserts[] = [
                    'id' => $id,
                    'calendar_id' => $calendarId,
                    'title' => mb_substr($item['subject'] ?? '(busy)', 0, 500),
                    'starts_at' => $start->utc(),
                    'ends_at' => $end->utc(),
                    'all_day' => $allDay,
                    'show_as' => (string) ($item['showAs'] ?? 'busy'),
                    'ical_uid' => isset($item['iCalUId']) ? mb_substr((string) $item['iCalUId'], 0, 1024) : null,
                    'series_id' => $item['seriesMasterId'] ?? null,
                    'original_start' => isset($item['originalStart']) ? CarbonImmutable::parse($item['originalStart'])->utc() : null,
                    'timezone' => WindowsZones::toIana($item['originalStartTimeZone'] ?? null),
                ];
            }
            $url = $page['@odata.nextLink'] ?? null;
            $next = $page['@odata.deltaLink'] ?? $next;
        }

        return new ChangeSet($upserts, $removed, $next, $syncToken === null);
    }

    public function revoke(string $token): void
    {
        // Microsoft identity platform has no token revocation endpoint for delegated tokens; deleting our copy is sufficient.
    }

    public function writeScope(): string
    {
        return self::WRITE_SCOPE;
    }

    public function writeAuthorizationUrl(string $state, string $codeChallenge, ?string $loginHint): string
    {
        return 'https://login.microsoftonline.com/'.rawurlencode($this->config()['tenant'] ?? 'common').'/oauth2/v2.0/authorize?'.http_build_query(array_filter([
            'client_id' => $this->config()['client_id'],
            'redirect_uri' => $this->config()['redirect'],
            'response_type' => 'code',
            'response_mode' => 'query',
            'scope' => self::SCOPES.' '.self::WRITE_SCOPE,
            'login_hint' => $loginHint,
            'state' => $state,
            'code_challenge' => $codeChallenge,
            'code_challenge_method' => 'S256',
            'prompt' => 'consent',
        ]));
    }

    public function writeScopeGranted(?string $granted): bool
    {
        foreach (preg_split('/\s+/', (string) $granted) ?: [] as $scope) {
            if (strcasecmp($scope, self::WRITE_SCOPE) === 0 || strcasecmp($scope, 'https://graph.microsoft.com/'.self::WRITE_SCOPE) === 0) {
                return true;
            }
        }

        return false;
    }

    public function writableCalendars(string $accessToken): array
    {
        $calendars = $this->send(fn () => $this->http($accessToken)->get('https://graph.microsoft.com/v1.0/me/calendars', ['$select' => 'id,name,canEdit,isDefaultCalendar', '$top' => 100]))->json('value') ?? [];

        return array_values(array_map(fn (array $c) => ['id' => (string) $c['id'], 'name' => mb_substr((string) ($c['name'] ?? 'Calendar'), 0, 200), 'primary' => (bool) ($c['isDefaultCalendar'] ?? false)],
            array_filter($calendars, fn (array $c) => (bool) ($c['canEdit'] ?? false))));
    }

    public function createEvent(string $accessToken, string $calendarId, string $clientId, string $title, CarbonImmutable $start, CarbonImmutable $end): array
    {
        // transactionId lets Graph recognise a repeated request instead of creating a second copy.
        try {
            $event = $this->write($accessToken, fn ($http) => $http->post('https://graph.microsoft.com/v1.0/me/calendars/'.rawurlencode($calendarId).'/events', [
                'subject' => $title, 'transactionId' => $clientId,
                'start' => ['dateTime' => $start->utc()->format('Y-m-d\TH:i:s'), 'timeZone' => 'UTC'], 'end' => ['dateTime' => $end->utc()->format('Y-m-d\TH:i:s'), 'timeZone' => 'UTC'],
            ]))->json();
        } catch (CalendarWriteException $e) {
            if ($e->reason === 'changed') {
                throw new CalendarWriteException('uncertain', 'Outlook reports this event may already have been added. Check Outlook before trying again.');
            }
            throw $e;
        }

        return ['id' => (string) $event['id'], 'etag' => $event['@odata.etag'] ?? null];
    }

    public function updateEvent(string $accessToken, string $calendarId, string $eventId, ?string $etag, string $title, CarbonImmutable $start, CarbonImmutable $end): array
    {
        $event = $this->write($accessToken, fn ($http) => $http->withHeaders(array_filter(['If-Match' => $etag]))->patch('https://graph.microsoft.com/v1.0/me/events/'.rawurlencode($eventId), [
            'subject' => $title, 'start' => ['dateTime' => $start->utc()->format('Y-m-d\TH:i:s'), 'timeZone' => 'UTC'], 'end' => ['dateTime' => $end->utc()->format('Y-m-d\TH:i:s'), 'timeZone' => 'UTC'],
        ]))->json();

        return ['id' => (string) $event['id'], 'etag' => $event['@odata.etag'] ?? null];
    }

    public function deleteEvent(string $accessToken, string $calendarId, string $eventId, ?string $etag): void
    {
        $this->write($accessToken, fn ($http) => $http->withHeaders(array_filter(['If-Match' => $etag]))->delete('https://graph.microsoft.com/v1.0/me/events/'.rawurlencode($eventId)), missingIsDone: true);
    }
}
