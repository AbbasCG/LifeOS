<?php

namespace App\Integrations\Calendar;

/** The provider asked us to slow down (429, or Google's 403 rate-limit reasons). Retry after the given delay. */
class RateLimitedException extends ProviderException
{
    public function __construct(string $message, public readonly int $retryAfter = 60)
    {
        parent::__construct($message);
    }
}
