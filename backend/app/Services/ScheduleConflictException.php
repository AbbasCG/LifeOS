<?php

namespace App\Services;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * A calendar write was refused because the requested time overlaps something already on the user's calendar.
 *
 * It IS a ValidationException (HTTP 422, `message`, `errors.<key>`), so existing clients and catch blocks keep working; render() only adds the
 * machine-readable `conflict` object (code, requested time, up to five conflicting items, a suggested free slot) next to them.
 */
class ScheduleConflictException extends ValidationException
{
    public const CODE = 'schedule_conflict';

    /** @var array<string, mixed> */
    public array $conflict = [];

    /**
     * @param  array<string, mixed>  $conflict
     */
    public static function make(string $errorKey, string $message, array $conflict): static
    {
        $validator = Validator::make([], []);
        $validator->errors()->add($errorKey, $message);
        $exception = new static($validator);
        $exception->conflict = $conflict;

        return $exception;
    }

    public function render(): JsonResponse
    {
        return response()->json(['message' => $this->getMessage(), 'errors' => $this->errors(), 'conflict' => $this->conflict], $this->status);
    }
}
