<?php

namespace App\Integrations\Tasks;

use App\Integrations\Calendar\ChangeSet;
use App\Integrations\Calendar\OAuthProvider;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Http;

/**
 * Google Tasks, read-only (tasks.readonly). Uses the same Google OAuth client as Google Calendar with its own consent.
 */
class GoogleTasksProvider extends OAuthProvider implements TaskProvider
{
    public const SCOPES = 'openid email profile https://www.googleapis.com/auth/tasks.readonly';

    public function name(): string
    {
        return 'google_tasks';
    }

    public function label(): string
    {
        return 'Google Tasks';
    }

    public function category(): string
    {
        return 'tasks';
    }

    public function scopeSummary(): string
    {
        return 'Read-only access to your task lists and tasks (tasks.readonly), plus your name and email address.';
    }

    public function envKeys(): array
    {
        return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TASKS_REDIRECT_URI'];
    }

    protected function configKey(): string
    {
        return 'google_tasks';
    }

    protected function tokenUrl(): string
    {
        return 'https://oauth2.googleapis.com/token';
    }

    public function authorizationUrl(string $state, string $codeChallenge): string
    {
        return 'https://accounts.google.com/o/oauth2/v2/auth?'.http_build_query([
            'client_id' => $this->config()['client_id'], 'redirect_uri' => $this->redirectUri(), 'response_type' => 'code', 'scope' => self::SCOPES,
            'access_type' => 'offline', 'prompt' => 'consent', 'state' => $state, 'code_challenge' => $codeChallenge, 'code_challenge_method' => 'S256',
        ]);
    }

    public function account(string $accessToken): array
    {
        $profile = $this->send(fn () => $this->http($accessToken)->get('https://openidconnect.googleapis.com/v1/userinfo'))->json();

        return ['id' => (string) $profile['sub'], 'email' => $profile['email'] ?? null, 'name' => $profile['name'] ?? null];
    }

    public function collections(string $accessToken): array
    {
        $lists = $this->send(fn () => $this->http($accessToken)->get('https://tasks.googleapis.com/tasks/v1/users/@me/lists', ['maxResults' => 100]))->json('items') ?? [];

        return array_values(array_map(fn (array $l, int $i) => ['id' => (string) $l['id'], 'name' => mb_substr((string) ($l['title'] ?? 'Tasks'), 0, 200), 'color' => null, 'primary' => $i === 0, 'default_included' => $i === 0], $lists, array_keys($lists)));
    }

    public function requiredScopes(): array
    {
        return ['tasks.readonly'];
    }

    public function taskChanges(string $accessToken, string $listId, ?string $syncToken, string $userTimezone): ChangeSet
    {
        // Google Tasks has no sync token; "updatedMin" (the start time of the previous read) returns changes including
        // deleted and completed tasks. The token we store is that start time.
        $startedAt = CarbonImmutable::now()->subMinute()->toIso8601ZuluString();
        $params = ['showCompleted' => 'true', 'showHidden' => 'true', 'maxResults' => 100] + ($syncToken !== null ? ['updatedMin' => $syncToken, 'showDeleted' => 'true'] : []);
        $upserts = [];
        $removed = [];
        $pageToken = null;
        do {
            $page = $this->send(fn () => $this->http($accessToken)->get('https://tasks.googleapis.com/tasks/v1/lists/'.rawurlencode($listId).'/tasks', array_filter($params + ['pageToken' => $pageToken])))->json();
            foreach ($page['items'] ?? [] as $item) {
                $id = $listId.'|'.$item['id'];
                $title = trim((string) ($item['title'] ?? ''));
                if (($item['deleted'] ?? false) || $title === '') {
                    $removed[] = $id;

                    continue;
                }
                // Google Tasks stores only a date; the time part of "due" is always midnight UTC and must be ignored.
                $due = isset($item['due']) ? CarbonImmutable::parse(substr((string) $item['due'], 0, 10), $userTimezone)->setTime(23, 59) : null;
                $done = ($item['status'] ?? '') === 'completed';
                $upserts[] = ['id' => $id, 'list_id' => $listId, 'title' => mb_substr($title, 0, 500), 'due_at' => $due?->utc(), 'due_is_date' => true, 'priority' => null, 'url' => $item['webViewLink'] ?? null,
                    'status' => $done ? 'completed' : 'open', 'completed_at' => $done && isset($item['completed']) ? CarbonImmutable::parse($item['completed'])->utc() : null];
            }
            $pageToken = $page['nextPageToken'] ?? null;
        } while ($pageToken);

        return new ChangeSet($upserts, $removed, $startedAt, $syncToken === null);
    }

    public function revoke(string $token): void
    {
        Http::asForm()->timeout(10)->post('https://oauth2.googleapis.com/revoke', ['token' => $token]);
    }
}
