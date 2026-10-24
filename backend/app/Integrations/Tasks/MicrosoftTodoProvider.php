<?php

namespace App\Integrations\Tasks;

use App\Integrations\Calendar\ChangeSet;
use App\Integrations\Calendar\OAuthProvider;
use App\Integrations\Calendar\SyncTokenExpiredException;
use Carbon\CarbonImmutable;

/**
 * Microsoft To Do via Microsoft Graph, read-only (Tasks.Read). Uses the same Entra ID app as Outlook Calendar.
 */
class MicrosoftTodoProvider extends OAuthProvider implements TaskProvider
{
    public const SCOPES = 'openid email profile offline_access User.Read Tasks.Read';

    public function name(): string
    {
        return 'microsoft_todo';
    }

    public function label(): string
    {
        return 'Microsoft To Do';
    }

    public function category(): string
    {
        return 'tasks';
    }

    public function scopeSummary(): string
    {
        return 'Read-only access to your To Do lists and tasks (Tasks.Read), your basic profile (User.Read) and offline access.';
    }

    public function envKeys(): array
    {
        return ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'MICROSOFT_TODO_REDIRECT_URI'];
    }

    protected function configKey(): string
    {
        return 'microsoft_todo';
    }

    protected function tokenUrl(): string
    {
        return 'https://login.microsoftonline.com/'.rawurlencode($this->config()['tenant'] ?? 'common').'/oauth2/v2.0/token';
    }

    public function authorizationUrl(string $state, string $codeChallenge): string
    {
        return 'https://login.microsoftonline.com/'.rawurlencode($this->config()['tenant'] ?? 'common').'/oauth2/v2.0/authorize?'.http_build_query([
            'client_id' => $this->config()['client_id'], 'redirect_uri' => $this->redirectUri(), 'response_type' => 'code', 'response_mode' => 'query',
            'scope' => self::SCOPES, 'state' => $state, 'code_challenge' => $codeChallenge, 'code_challenge_method' => 'S256', 'prompt' => 'select_account',
        ]);
    }

    public function account(string $accessToken): array
    {
        $me = $this->send(fn () => $this->http($accessToken)->get('https://graph.microsoft.com/v1.0/me', ['$select' => 'id,displayName,mail,userPrincipalName']))->json();

        return ['id' => (string) $me['id'], 'email' => $me['mail'] ?? $me['userPrincipalName'] ?? null, 'name' => $me['displayName'] ?? null];
    }

    public function collections(string $accessToken): array
    {
        $lists = $this->send(fn () => $this->http($accessToken)->get('https://graph.microsoft.com/v1.0/me/todo/lists'))->json('value') ?? [];

        return array_values(array_map(fn (array $l) => [
            'id' => (string) $l['id'], 'name' => mb_substr((string) ($l['displayName'] ?? 'Tasks'), 0, 200), 'color' => null,
            'primary' => ($l['wellknownListName'] ?? '') === 'defaultList', 'default_included' => ($l['wellknownListName'] ?? '') === 'defaultList',
        ], $lists));
    }

    public function requiredScopes(): array
    {
        return ['Tasks.Read'];
    }

    public function taskChanges(string $accessToken, string $listId, ?string $syncToken, string $userTimezone): ChangeSet
    {
        // Graph delta for To Do tasks: the first read returns every task, later reads (deltaLink) only changes and
        // "@removed" deletions.
        $url = $syncToken ?? 'https://graph.microsoft.com/v1.0/me/todo/lists/'.rawurlencode($listId).'/tasks/delta';
        if (! str_starts_with($url, 'https://graph.microsoft.com/')) {
            throw new SyncTokenExpiredException('Unexpected delta link.');
        }
        $upserts = [];
        $removed = [];
        $next = null;
        while ($url) {
            $page = $this->send(fn () => $this->http($accessToken)->withHeaders(['Prefer' => 'odata.maxpagesize=100'])->get($url))->json();
            foreach ($page['value'] ?? [] as $item) {
                $id = (string) $item['id'];
                $title = trim((string) ($item['title'] ?? ''));
                if (isset($item['@removed']) || $title === '') {
                    $removed[] = $id;

                    continue;
                }
                // To Do due dates are calendar dates; read the date part in the user's timezone.
                $due = isset($item['dueDateTime']['dateTime']) ? CarbonImmutable::parse(substr((string) $item['dueDateTime']['dateTime'], 0, 10), $userTimezone)->setTime(23, 59) : null;
                $done = ($item['status'] ?? '') === 'completed';
                $completed = $item['completedDateTime']['dateTime'] ?? null;
                $upserts[] = ['id' => $id, 'list_id' => $listId, 'title' => mb_substr($title, 0, 500), 'due_at' => $due?->utc(), 'due_is_date' => true, 'priority' => ($item['importance'] ?? '') === 'high' ? 'high' : null, 'url' => null,
                    'status' => $done ? 'completed' : 'open', 'completed_at' => $done && $completed ? CarbonImmutable::parse($completed, $item['completedDateTime']['timeZone'] ?? 'UTC')->utc() : null];
            }
            $url = $page['@odata.nextLink'] ?? null;
            $next = $page['@odata.deltaLink'] ?? $next;
        }

        return new ChangeSet($upserts, $removed, $next, $syncToken === null);
    }

    public function revoke(string $token): void
    {
        // Microsoft identity platform has no revocation endpoint for delegated tokens; deleting our copy is sufficient.
    }
}
