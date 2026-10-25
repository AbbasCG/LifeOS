<?php

namespace App\Integrations\Calendar;

use RuntimeException;

/**
 * A write to a connected calendar did not happen. The reason tells the caller what is safe to do next:
 * "denied" (write permission missing or withdrawn), "gone" (the copy no longer exists there), "changed" (someone
 * edited the copy there since LifeOS wrote it), "rate_limited", "uncertain" (no answer — the change may or may not have
 * happened, so check before retrying) or "failed".
 */
class CalendarWriteException extends RuntimeException
{
    public function __construct(public readonly string $reason, string $message, public readonly int $retryAfter = 0)
    {
        parent::__construct($message);
    }
}
