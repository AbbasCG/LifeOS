<?php

namespace App\Integrations\Calendar;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Http;

class GoogleCalendarProvider extends OAuthProvider
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

    public function events(string $accessToken, CarbonImmutable $from, CarbonImmutable $to, string $userTimezone): iterable
    {
        $calendars = $this->send(fn () => $this->http($accessToken)->get('https://www.googleapis.com/calendar/v3/users/me/calendarList', ['minAccessRole' => 'reader', 'maxResults' => 250]))->json('items') ?? [];
        foreach ($calendars as $calendar) {
            if (($calendar['selected'] ?? true) === false || ($calendar['hidden'] ?? false)) {
                continue;
            }
            $calendarZone = $calendar['timeZone'] ?? $userTimezone;
            $pageToken = null;
            do {
                $page = $this->send(fn () => $this->http($accessToken)->get('https://www.googleapis.com/calendar/v3/calendars/'.rawurlencode($calendar['id']).'/events', array_filter([
                    'timeMin' => $from->toIso8601ZuluString(),
                    'timeMax' => $to->toIso8601ZuluString(),
                    'singleEvents' => 'true',
                    'orderBy' => 'startTime',
                    'maxResults' => 2500,
                    'pageToken' => $pageToken,
                ])))->json();
                foreach ($page['items'] ?? [] as $item) {
                    if (($item['status'] ?? '') === 'cancelled' || ($item['transparency'] ?? 'opaque') === 'transparent') {
                        continue;
                    }
                    $allDay = isset($item['start']['date']);
                    $zone = $item['start']['timeZone'] ?? $calendarZone;
                    $start = $allDay ? CarbonImmutable::parse($item['start']['date'], $zone)->startOfDay() : CarbonImmutable::parse($item['start']['dateTime']);
                    $end = $allDay ? CarbonImmutable::parse($item['end']['date'], $zone)->startOfDay() : CarbonImmutable::parse($item['end']['dateTime']);
                    yield [
                        'id' => $calendar['id'].'|'.$item['id'],
                        'calendar_id' => $calendar['id'],
                        'title' => mb_substr($item['summary'] ?? '(busy)', 0, 500),
                        'starts_at' => $start->utc(),
                        'ends_at' => $end->utc(),
                        'all_day' => $allDay,
                        'show_as' => 'busy',
                    ];
                }
                $pageToken = $page['nextPageToken'] ?? null;
            } while ($pageToken);
        }
    }

    public function revoke(string $token): void
    {
        Http::asForm()->timeout(10)->post('https://oauth2.googleapis.com/revoke', ['token' => $token]);
    }
}
