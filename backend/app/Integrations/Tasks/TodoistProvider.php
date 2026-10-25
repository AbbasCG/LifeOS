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

    /** @var array<string, array{full: bool, token: ?string, items: list<array<string, mixed>>}> one Sync API read per token and run */
    private array $syncCache = [];

    public function taskChanges(string $accessToken, string $listId, ?string $syncToken, string $userTimezone): ChangeSet
    {
        // The Sync API returns every project's changes in one read, so it is fetched once per run and filtered per
        // project. A full read lists active tasks only; incremental reads also report completed and deleted ones.
        $key = hash('sha256', $accessToken).'|'.($syncToken ?? '*');
        $sync = $this->syncCache[$key] ??= $this->readSync($accessToken, $syncToken);
        $upserts = [];
        $removed = [];
        foreach ($sync['items'] as $item) {
            $id = (string) ($item['id'] ?? '');
            if ($id === '') {
                continue;
            }
            if ((string) ($item['project_id'] ?? '') !== $listId || ($item['is_deleted'] ?? false)) {
                // Moved to another project (re-imported there if that project is chosen) or deleted in Todoist.
                if (! $sync['full']) {
                    $removed[] = $id;
                }

                continue;
            }
            $row = $this->row($item, $listId, $userTimezone);
            if ($row === null || ($sync['full'] && $row['status'] === 'completed')) {
                continue;
            }
            $upserts[] = $row;
        }

        return new ChangeSet($upserts, $removed, $sync['token'], $sync['full']);
    }

    /**
     * @return array{full: bool, token: ?string, items: list<array<string, mixed>>}
     */
    private function readSync(string $accessToken, ?string $syncToken): array
    {
        $response = $this->send(fn () => $this->http($accessToken)->asForm()->post(self::API.'/sync', ['sync_token' => $syncToken ?? '*', 'resource_types' => '["items"]']))->json();
        $token = $response['sync_token'] ?? null;

        return ['full' => $syncToken === null || (bool) ($response['full_sync'] ?? false), 'token' => is_string($token) && $token !== '' ? $token : null, 'items' => array_values(array_filter($response['items'] ?? [], 'is_array'))];
    }

    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>|null
     */
    private function row(array $item, string $listId, string $userTimezone): ?array
    {
        $title = trim((string) ($item['content'] ?? ''));
        if ($title === '') {
            return null;
        }
        $date = $item['due']['date'] ?? null;
        $dateOnly = $date !== null && strlen((string) $date) === 10;
        // Date-only dues end the day; floating times are local to the user; times with an offset are absolute.
        $due = $date === null ? null : ($dateOnly ? CarbonImmutable::parse($date, $userTimezone)->setTime(23, 59) : CarbonImmutable::parse($date, $item['due']['timezone'] ?? $userTimezone));
        $priority = [4 => 'urgent', 3 => 'high', 2 => 'medium'][(int) ($item['priority'] ?? 1)] ?? null;
        $completed = (bool) ($item['checked'] ?? false);
        $completedAt = $completed && ! empty($item['completed_at']) ? CarbonImmutable::parse($item['completed_at'])->utc() : ($completed ? CarbonImmutable::now()->utc() : null);

        return ['id' => (string) $item['id'], 'list_id' => $listId, 'title' => mb_substr($title, 0, 500), 'due_at' => $due?->utc(), 'due_is_date' => $dateOnly, 'priority' => $priority,
            'url' => 'https://app.todoist.com/app/task/'.rawurlencode((string) $item['id']), 'status' => $completed ? 'completed' : 'open', 'completed_at' => $completedAt];
    }

    public function revoke(string $token): void
    {
        // Todoist access is removed by the user under Settings → Integrations in Todoist; deleting our copy stops all access from LifeOS.
    }
}
