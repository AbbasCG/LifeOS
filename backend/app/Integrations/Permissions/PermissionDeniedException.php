<?php

namespace App\Integrations\Permissions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/** LifeOS refused an operation on a connected account because the person did not allow it (or the provider or the granted access cannot do it). */
class PermissionDeniedException extends RuntimeException
{
    public function __construct(public readonly string $operation, public readonly string $reason, string $message)
    {
        parent::__construct($message);
    }

    /** 403 with a code the screen can act on (re-consent, change the permission), never a provider message. */
    public function render(): JsonResponse
    {
        return response()->json(['message' => $this->getMessage(), 'code' => 'permission_denied', 'operation' => $this->operation, 'reason' => $this->reason], 403);
    }
}
