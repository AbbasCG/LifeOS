<?php

namespace App\Services;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/**
 * A task cannot take (another) calendar session. `errorCode` is machine-readable, `status` the HTTP status and `extra` is merged into the
 * JSON body (e.g. the conflicting session). Rendered by the framework as a JSON response, so no controller has to catch it.
 */
class TaskScheduleException extends RuntimeException
{
    /**
     * @param  array<string, mixed>  $extra
     */
    public function __construct(public readonly string $errorCode, string $message, public readonly int $status = 409, public readonly array $extra = [])
    {
        parent::__construct($message);
    }

    public function render(): JsonResponse
    {
        return response()->json(['message' => $this->getMessage(), 'code' => $this->errorCode] + $this->extra, $this->status);
    }
}
