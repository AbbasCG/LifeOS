<?php

namespace App\Integrations\Tasks;

use App\Integrations\Calendar\ChangeSet;
use App\Integrations\Calendar\OAuthProvider;
use App\Integrations\Calendar\ProviderAuthException;
use App\Integrations\Calendar\TokenSet;
use Carbon\CarbonImmutable;

/**
 * Todoist (API v1), read-only (data:read). Todoist's OAuth does not use PKCE or refresh tokens; its access tokens do
 * not expire and are revoked by the user in Todoist's settings or by disconnecting here.
 */
class TodoistProvider extends OAuthProvider implements TaskProvider
{
    public const API = 'https://api.todoist.com/api/v1';

    public function name(): string
    {
        return 'todoist';
    }

    public function label(): string
    {
        return 'Todoist';
    }

    public function category(): string
    {
        return 'tasks';
    }

    public function scopeSummary(): string
    {
        return 'Read-only access to your projects and tasks (data:read).';
    }

    public function envKeys(): array
    {
        return ['TODOIST_CLIENT_ID', 'TODOIST_CLIENT_SECRET', 'TODOIST_REDIRECT_URI'];
    }

    protected function configKey(): string
    {
        return 'todoist';
    }

    protected function tokenUrl(): string
    {
        return 'https://todoist.com/oauth/access_token';
    }

    public function authorizationUrl(string $state, string $codeChallenge): string
    {
        return 'https://todoist.com/oauth/authorize?'.http_build_query(['client_id' => $this->config()['client_id'], 'scope' => 'data:read', 'state' => $state]);
    }

    public function exchangeCode(string $code, string $codeVerifier): TokenSet
    {
        return TokenSet::fromResponse($this->tokenRequest(['code' => $code, 'redirect_uri' => $this->redirectUri()]));
    }

    public function refresh(string $refreshToken): TokenSet
    {
        throw new ProviderAuthException('Todoist access cannot be refreshed. Reconnect Todoist.');
    }

    public function account(string $accessToken): array
    {
        $user = $this->send(fn () => $this->http($accessToken)->get(self::API.'/user'))->json();

        return ['id' => (string) $user['id'], 'email' => $user['email'] ?? null, 'name' => $user['full_name'] ?? null];
    }

    public function collections(string $accessToken): array
    {
        $projects = [];
        $cursor = null;
        do {
            $page = $this->send(fn () => $this->http($accessToken)->get(self::API.'/projects', array_filter(['limit' => 200, 'cursor' => $cursor])))->json();
            array_push($projects, ...($page['results'] ?? []));
            $cursor = $page['next_cursor'] ?? null;
        } while ($cursor);

        return array_values(array_map(fn (array $p) => [
            'id' => (string) $p['id'], 'name' => mb_substr((string) ($p['name'] ?? 'Project'), 0, 200), 'color' => null,
            'primary' => (bool) ($p['inbox_project'] ?? false), 'default_included' => (bool) ($p['inbox_project'] ?? false),
        ], $projects));
    }

    public function requiredScopes(): array
    {
        return ['data:read'];
    }

    public function taskChanges(string $accessToken, string $listId, ?string $syncToken, string $userTimezone): ChangeSet
    {
        // Todoist's REST API returns active tasks only and has no change feed for read-only access, so every read is
        // full: tasks that disappear were completed or deleted in Todoist and are removed here.
        $upserts = [];
        $cursor = null;
        do {
            $page = $this->send(fn () => $this->http($accessToken)->get(self::API.'/tasks', array_filter(['project_id' => $listId, 'limit' => 200, 'cursor' => $cursor])))->json();
            foreach ($page['results'] ?? [] as $item) {
                $title = trim((string) ($item['content'] ?? ''));
                if ($title === '' || ($item['checked'] ?? false)) {
                    continue;
                }
                $date = $item['due']['date'] ?? null;
                $dateOnly = $date !== null && strlen((string) $date) === 10;
                // Date-only dues end the day; floating times are local to the user; times with an offset are absolute.
                $due = $date === null ? null : ($dateOnly ? CarbonImmutable::parse($date, $userTimezone)->setTime(23, 59) : CarbonImmutable::parse($date, $item['due']['timezone'] ?? $userTimezone));
                $priority = [4 => 'urgent', 3 => 'high', 2 => 'medium'][(int) ($item['priority'] ?? 1)] ?? null;
                $upserts[] = ['id' => (string) $item['id'], 'list_id' => $listId, 'title' => mb_substr($title, 0, 500), 'due_at' => $due?->utc(), 'due_is_date' => $dateOnly, 'priority' => $priority,
                    'url' => 'https://app.todoist.com/app/task/'.rawurlencode((string) $item['id']), 'status' => 'open', 'completed_at' => null];
            }
            $cursor = $page['next_cursor'] ?? null;
        } while ($cursor);

        return new ChangeSet($upserts, [], null, true);
    }

    public function revoke(string $token): void
    {
        // Todoist access is removed by the user under Settings → Integrations in Todoist; deleting our copy stops all access from LifeOS.
    }
}
