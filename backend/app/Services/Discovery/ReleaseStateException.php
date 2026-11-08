<?php

namespace App\Services\Discovery;

use RuntimeException;

/** A release cannot move to the requested state; `code` is machine-readable and `status` the HTTP status to answer with. */
class ReleaseStateException extends RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message, public readonly int $status = 409)
    {
        parent::__construct($message);
    }
}
