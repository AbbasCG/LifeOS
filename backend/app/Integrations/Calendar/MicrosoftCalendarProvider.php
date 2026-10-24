<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;

class MicrosoftCalendarProvider extends OAuthProvider implements CalendarProvider
{
    public const SCOPES = 'openid email profile offline_access User.Read Calendars.Read';

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

    public function events(string $accessToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone, ?array $calendarIds = null): iterable
    {
        $query = http_build_query([
            'startDateTime' => $from->toIso8601ZuluString(),
            'endDateTime' => $to->toIso8601ZuluString(),
            '$top' => 500,
            '$select' => 'id,subject,start,end,isAllDay,showAs,isCancelled',
        ]);
        // null: the default calendar only (behaviour before calendar selection); otherwise each chosen calendar.
        foreach ($calendarIds === null ? [null] : $calendarIds as $calendarId) {
            yield from $this->calendarView($accessToken, $calendarId === null ? "https://graph.microsoft.com/v1.0/me/calendarView?{$query}" : 'https://graph.microsoft.com/v1.0/me/calendars/'.rawurlencode($calendarId)."/calendarView?{$query}", $calendarId, $userTimezone);
        }
    }

    /**
     * @return iterable<array<string, mixed>>
     */
    private function calendarView(string $accessToken, string $url, ?string $calendarId, string $userTimezone): iterable
    {
        while ($url) {
            $page = $this->send(fn () => $this->http($accessToken)->withHeaders(['Prefer' => 'outlook.timezone="UTC"'])->get($url))->json();
            foreach ($page['value'] ?? [] as $item) {
                if (($item['isCancelled'] ?? false) || in_array($item['showAs'] ?? 'busy', ['free', 'workingElsewhere'], true)) {
                    continue;
                }
                $allDay = (bool) ($item['isAllDay'] ?? false);
                // Graph returns UTC wall times without an offset when Prefer: outlook.timezone="UTC" is set; all-day events are midnight-to-midnight in the user's zone.
                $start = $allDay ? CarbonImmutable::parse(substr($item['start']['dateTime'], 0, 10), $userTimezone) : CarbonImmutable::parse($item['start']['dateTime'], 'UTC');
                $end = $allDay ? CarbonImmutable::parse(substr($item['end']['dateTime'], 0, 10), $userTimezone) : CarbonImmutable::parse($item['end']['dateTime'], 'UTC');
                yield [
                    'id' => (string) $item['id'],
                    'calendar_id' => $calendarId,
                    'title' => mb_substr($item['subject'] ?? '(busy)', 0, 500),
                    'starts_at' => $start->utc(),
                    'ends_at' => $end->utc(),
                    'all_day' => $allDay,
                    'show_as' => (string) ($item['showAs'] ?? 'busy'),
                ];
            }
            $url = $page['@odata.nextLink'] ?? null;
        }
    }

    public function revoke(string $token): void
    {
        // Microsoft identity platform has no token revocation endpoint for delegated tokens; deleting our copy is sufficient.
    }
}
