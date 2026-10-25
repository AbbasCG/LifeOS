<?php

namespace App\Integrations\Calendar;

use App\Integrations\Tasks\GoogleTasksProvider;
use App\Integrations\Tasks\MicrosoftTodoProvider;
use App\Integrations\Tasks\TaskProvider;
use App\Integrations\Tasks\TodoistProvider;

/**
 * Registry of every implemented connected provider (calendars and task services).
 */
class CalendarProviders
{
    /** @var array<string, ConnectedProvider> */
    private array $providers = [];

    public function __construct(GoogleCalendarProvider $google, MicrosoftCalendarProvider $microsoft, GoogleTasksProvider $googleTasks, MicrosoftTodoProvider $todo, TodoistProvider $todoist, IcsProvider $ics)
    {
        foreach ([$google, $microsoft, $googleTasks, $todo, $todoist, $ics] as $provider) {
            $this->providers[$provider->name()] = $provider;
        }
    }

    public function get(string $name): ?ConnectedProvider
    {
        return $this->providers[$name] ?? null;
    }

    /**
     * @return array<string, ConnectedProvider>
     */
    public function all(): array
    {
        return $this->providers;
    }

    /**
     * @return list<string>
     */
    public function names(): array
    {
        return array_keys($this->providers);
    }

    public function isTasks(string $name): bool
    {
        return ($this->providers[$name] ?? null) instanceof TaskProvider;
    }
}
