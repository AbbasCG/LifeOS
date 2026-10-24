<?php

namespace App\Integrations\Calendar;

/**
 * Registry of available calendar providers.
 */
class CalendarProviders
{
    /** @var array<string, CalendarProvider> */
    private array $providers = [];

    public function __construct(GoogleCalendarProvider $google, MicrosoftCalendarProvider $microsoft)
    {
        foreach ([$google, $microsoft] as $provider) {
            $this->providers[$provider->name()] = $provider;
        }
    }

    public function get(string $name): ?CalendarProvider
    {
        return $this->providers[$name] ?? null;
    }

    /**
     * @return array<string, CalendarProvider>
     */
    public function all(): array
    {
        return $this->providers;
    }
}
