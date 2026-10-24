<?php

namespace App\Integrations\Tasks;

use App\Integrations\Calendar\ConnectedProvider;
use Carbon\CarbonImmutable;

/**
 * A read-only external task service. Implementations never create, edit or complete tasks at the provider.
 */
interface TaskProvider extends ConnectedProvider
{
    /**
     * Open (not completed) tasks in the given lists.
     *
     * @param  list<string>  $listIds
     * @return iterable<array{id: string, list_id: string, title: string, due_at: CarbonImmutable|null, due_is_date: bool, priority: string|null, url: string|null}>
     */
    public function tasks(string $accessToken, array $listIds, string $userTimezone): iterable;
}
