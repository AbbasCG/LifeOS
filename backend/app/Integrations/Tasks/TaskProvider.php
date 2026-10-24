<?php

namespace App\Integrations\Tasks;

use App\Integrations\Calendar\ChangeSet;
use App\Integrations\Calendar\ConnectedProvider;

/**
 * A read-only external task service. Implementations never create, edit or complete tasks at the provider.
 *
 * Each upserted task: id, list_id, title, due_at (UTC|null), due_is_date, priority, url, status (open|completed),
 * completed_at (UTC|null).
 */
interface TaskProvider extends ConnectedProvider
{
    /**
     * Read one task list: everything without a token, only changes with one.
     */
    public function taskChanges(string $accessToken, string $listId, ?string $syncToken, string $userTimezone): ChangeSet;
}
