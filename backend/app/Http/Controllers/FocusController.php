<?php

namespace App\Http\Controllers;

use App\Http\Resources\WorkspaceResource;
use App\Jobs\FireAutomations;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use App\Services\FocusInsights;
use App\Services\Notifier;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class FocusController extends Controller
{
    public const MAX_INTERRUPTIONS = 50;

    /** Seconds of clock rounding allowed when the page reports that the countdown reached zero. */
    public const FINISH_TOLERANCE_SECONDS = 2;

    public function index(Request $request): mixed
    {
        return FocusSession::where('user_id', $request->user()->id)->with(['task:id,title,status', 'project:id,title,color'])->latest()->latest('id')->paginate(50);
    }

    public function insights(Request $request, FocusInsights $insights): JsonResponse
    {
        return response()->json($insights->summary($request->user(), min(365, max(7, $request->integer('days', 30)))));
    }

    public function today(Request $request, FocusInsights $insights): JsonResponse
    {
        return response()->json($insights->today($request->user()));
    }

    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        $data = $request->validate([
            'task_id' => ['nullable', Rule::exists('tasks', 'id')->where('user_id', $user->id)],
            'project_id' => ['nullable', Rule::exists('projects', 'id')->where('user_id', $user->id)],
            'duration_seconds' => 'required|integer|min:60|max:14400',
            'kind' => 'required|in:focus,short_break,long_break,manual',
            'mode' => ['nullable', Rule::in(FocusSession::MODES)],
            'cycle' => 'nullable|integer|min:1|max:24',
            'notes' => 'nullable|string|max:2000',
            'client_id' => 'nullable|uuid',
        ]);
        if (! empty($data['client_id']) && ($existing = FocusSession::where('user_id', $user->id)->where('client_id', $data['client_id'])->first())) {
            // A retried request (e.g. flaky mobile connection) returns the session it already created.
            return response()->json($existing->load(['task:id,title,status', 'project:id,title,color']));
        }
        if (! empty($data['task_id']) && empty($data['project_id'])) {
            $data['project_id'] = Task::whereKey($data['task_id'])->value('project_id');
        }
        $session = DB::transaction(function () use ($user, $data) {
            User::whereKey($user->id)->lockForUpdate()->firstOrFail();
            if (FocusSession::where('user_id', $user->id)->whereIn('status', ['running', 'paused'])->exists()) {
                throw ValidationException::withMessages(['session' => ['Finish or cancel your active session first.']]);
            }
            $manual = $data['kind'] === 'manual';
            if ($manual) {
                $start = now()->subSeconds($data['duration_seconds']);
                $overlap = FocusSession::where('user_id', $user->id)->where('status', 'completed')->whereIn('kind', ['focus', 'manual'])
                    ->where('completed_at', '>', $start)->get()->filter(fn (FocusSession $s) => ($s->started_at ?? $s->completed_at->subSeconds($s->elapsed_seconds)) < now());
                if ($overlap->isNotEmpty()) {
                    // Nothing is changed or removed: say how much of the time since the last session is still free.
                    $free = (int) floor(max(0, $overlap->max('completed_at')->diffInSeconds(now(), false)) / 60);
                    $hint = $free >= 1 ? " You can log up to {$free} minutes since it ended, or shorten the entry." : ' Shorten the entry so time is not counted twice.';
                    throw ValidationException::withMessages(['duration_seconds' => ['This time overlaps a session you already logged.'.$hint]]);
                }
            }
            $session = FocusSession::create($data + [
                'user_id' => $user->id, 'mode' => $data['kind'] === 'focus' ? ($data['mode'] ?? 'custom') : null,
                'started_at' => $manual ? now()->subSeconds($data['duration_seconds']) : now(), 'resumed_at' => $manual ? null : now(),
                'status' => $manual ? 'completed' : 'running', 'elapsed_seconds' => $manual ? $data['duration_seconds'] : 0, 'completed_at' => $manual ? now() : null,
            ]);
            if ($manual && $session->task_id) {
                Task::whereKey($session->task_id)->increment('actual_minutes', (int) floor($session->duration_seconds / 60));
            }

            return $session;
        });

        return response()->json($session->load(['task:id,title,status', 'project:id,title,color']), 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $data = $request->validate([
            'action' => 'required|in:pause,resume,finish,cancel,interrupt,note',
            'auto' => 'sometimes|boolean',
            'reason' => ['required_if:action,interrupt', 'nullable', Rule::in(FocusSession::DISTRACTIONS)],
            'note' => 'nullable|string|max:200',
            'notes' => 'nullable|string|max:2000',
        ]);
        $session = DB::transaction(function () use ($request, $id, $data) {
            $s = FocusSession::where('user_id', $request->user()->id)->lockForUpdate()->findOrFail($id);
            $action = $data['action'];
            if ($action === 'note') {
                // Saving a note must not move `updated_at`, which marks when the running time was last accounted for.
                $s->timestamps = false;
                $s->update(['notes' => $data['notes'] ?? null]);
                $s->timestamps = true;

                return $s;
            }
            if (in_array($s->status, ['completed', 'cancelled'])) {
                return $s;
            }
            if ($s->status === 'running' && $s->resumed_at) {
                $s->elapsed_seconds = $s->elapsedAt(now());
                $s->resumed_at = now();
            }
            // The page asks for an automatic finish when its countdown reaches zero. Only the server's clock decides whether that is true:
            // a wrong device clock or a stale tab must never end a session that still has time left (nothing is saved when it is refused).
            if ($action === 'finish' && ($data['auto'] ?? false) && $s->elapsed_seconds < $s->duration_seconds - self::FINISH_TOLERANCE_SECONDS) {
                throw ValidationException::withMessages(['action' => ['The session is not finished yet.']]);
            }
            if (array_key_exists('notes', $data) && $data['notes'] !== null) {
                $s->notes = $data['notes'];
            }
            if ($action === 'interrupt') {
                $log = $s->interruptions ?? [];
                if (count($log) >= self::MAX_INTERRUPTIONS) {
                    throw ValidationException::withMessages(['reason' => ['This session already has the maximum number of logged distractions.']]);
                }
                $log[] = ['at' => now()->toIso8601String(), 'reason' => $data['reason'], 'note' => $data['note'] ?? null, 'elapsed' => $s->elapsed_seconds];
                $s->interruptions = $log;
            }
            if ($action === 'resume') {
                $s->status = 'running';
                $s->resumed_at = now();
            }
            if ($action === 'pause') {
                $s->status = 'paused';
                $s->resumed_at = null;
            }
            if ($action === 'cancel') {
                $s->status = 'cancelled';
                $s->resumed_at = null;
            }
            if ($action === 'finish' || ($s->elapsed_seconds >= $s->duration_seconds && ! in_array($action, ['cancel', 'interrupt'], true))) {
                $s->status = 'completed';
                $s->completed_at = now();
                $s->resumed_at = null;
                if ($s->task_id && $s->kind === 'focus') {
                    Task::whereKey($s->task_id)->increment('actual_minutes', (int) floor($s->elapsed_seconds / 60));
                }
                $ar = ($request->user()->preferences()['language'] ?? 'en') === 'ar';
                app(Notifier::class)->send($request->user(), 'focus', 'focus:'.$s->id, $ar ? 'اكتملت جلسة التركيز' : 'Focus session completed', ['link' => '/focus', 'force' => true]);
                FireAutomations::dispatch($request->user()->id, 'focus_completed', $s->id)->afterCommit();
            }
            $s->save();

            return $s;
        });

        return response()->json($session->load(['task:id,title,status', 'project:id,title,color']));
    }

    /**
     * The person confirmed that the task of a finished focus session is done. Finishing a session only saves time; this is the one place a
     * session completes a task, and only the task that session was linked to. Asking again changes nothing (no second completion time and
     * no second next occurrence of a recurring task).
     */
    public function completeTask(Request $request, int $id): JsonResponse
    {
        $task = DB::transaction(function () use ($request, $id) {
            User::whereKey($request->user()->id)->lockForUpdate()->firstOrFail();
            $session = FocusSession::where('user_id', $request->user()->id)->findOrFail($id);
            if ($session->status !== 'completed' || $session->kind !== 'focus' || ! $session->task_id) {
                throw ValidationException::withMessages(['session' => ['Only a finished focus session linked to a task can complete that task.']]);
            }
            $task = Task::where('user_id', $request->user()->id)->lockForUpdate()->find($session->task_id);
            if (! $task) {
                throw ValidationException::withMessages(['session' => ['The task of this session no longer exists.']]);
            }
            if ($task->status !== 'completed') {
                $task->forceFill(['status' => 'completed', 'completed_at' => $task->completed_at ?? now()])->save();
                $task->createNextOccurrence();
            }

            return $task;
        });

        return (new WorkspaceResource($task->fresh()))->response();
    }
}
