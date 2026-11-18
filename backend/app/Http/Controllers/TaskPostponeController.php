<?php

namespace App\Http\Controllers;

use App\Http\Resources\WorkspaceResource;
use App\Models\Task;
use App\Services\TaskPostponer;
use App\Services\TaskScheduler;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * One-tap postpone of a task (POST /api/tasks/{id}/postpone) and its undo (POST /api/tasks/{id}/postpone/undo). The rules are TaskPostponer's.
 */
class TaskPostponeController extends Controller
{
    public function __construct(private TaskPostponer $postponer, private TaskScheduler $scheduler) {}

    public function postpone(Request $request, int $id): JsonResponse
    {
        $user = $request->user();
        $task = Task::where('user_id', $user->id)->findOrFail($id);
        $today = CarbonImmutable::now($user->timezone())->toDateString();
        $data = $request->validate([
            'to' => ['required', 'string', Rule::in(TaskPostponer::TARGETS)],
            'date' => ['required_if:to,date', 'prohibited_unless:to,date', 'nullable', 'date_format:Y-m-d', 'after_or_equal:'.$today, 'before:2100-01-01'],
            'expected_updated_at' => ['sometimes', 'nullable', 'date'],
        ], ['date.after_or_equal' => 'Choose today or a later day.']);

        if ($data['to'] === 'suggest') {
            $suggestion = $this->postponer->suggest($user, $task);

            return $this->task($task)->additional(['suggestion' => $suggestion])->response();
        }
        $result = $this->postponer->postpone($user, $id, $data, $this->idempotencyKey($request), $request);
        $response = $this->task(Task::where('user_id', $user->id)->findOrFail($id))->additional(['undo' => $result['undo'], 'moved' => (object) (array) $result['moved']])->response();

        return $result['replayed'] ? $response->header('Idempotent-Replay', 'true') : $response;
    }

    public function undo(Request $request, int $id): JsonResponse
    {
        $user = $request->user();
        Task::where('user_id', $user->id)->findOrFail($id);
        $data = $request->validate(['token' => ['required', 'string', 'max:100']]);
        $this->postponer->undo($user, $id, $data['token'], $request);

        return $this->task(Task::where('user_id', $user->id)->findOrFail($id))->response();
    }

    /** The task as the task API returns it, with its `schedule`. */
    private function task(Task $task): WorkspaceResource
    {
        $this->scheduler->attachSchedules($task->user_id, collect([$task]));

        return new WorkspaceResource($task);
    }

    /** The optional Idempotency-Key header (at most 100 characters). */
    private function idempotencyKey(Request $request): ?string
    {
        $key = $request->header('Idempotency-Key');
        if ($key === null || $key === '') {
            return null;
        }
        if (mb_strlen($key) > 100) {
            throw ValidationException::withMessages(['idempotency_key' => ['The Idempotency-Key header may be at most 100 characters.']]);
        }

        return $key;
    }
}
