<?php

namespace App\Http\Controllers;

use App\Models\FocusSession;
use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class FocusController extends Controller
{
    public function index(Request $request): mixed
    {
        return FocusSession::where('user_id', $request->user()->id)->latest()->paginate(50);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate(['task_id' => ['nullable', Rule::exists('tasks', 'id')->where('user_id', $request->user()->id)], 'duration_seconds' => 'required|integer|min:60|max:14400', 'kind' => 'required|in:focus,short_break,long_break,manual']);
        $session = DB::transaction(function () use ($request, $data) {
            User::whereKey($request->user()->id)->lockForUpdate()->firstOrFail();
            if (FocusSession::where('user_id', $request->user()->id)->whereIn('status', ['running', 'paused'])->exists()) {
                throw ValidationException::withMessages(['session' => ['Finish or cancel your active session first.']]);
            }
            $manual = $data['kind'] === 'manual';
            $session = FocusSession::create($data + ['user_id' => $request->user()->id, 'resumed_at' => $manual ? null : now(), 'status' => $manual ? 'completed' : 'running', 'elapsed_seconds' => $manual ? $data['duration_seconds'] : 0, 'completed_at' => $manual ? now() : null]);
            if ($manual && $session->task_id) {
                Task::whereKey($session->task_id)->increment('actual_minutes', (int) floor($session->duration_seconds / 60));
            }

return $session;
        });

        return response()->json($session, 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['action' => 'required|in:pause,resume,finish,cancel']);
        $session = DB::transaction(function () use ($request, $id, $data) {
            $s = FocusSession::where('user_id', $request->user()->id)->lockForUpdate()->findOrFail($id);
            if (in_array($s->status, ['completed', 'cancelled'])) {
                return $s;
            }
            if ($s->status === 'running' && $s->resumed_at) {
                $s->elapsed_seconds = min($s->duration_seconds, $s->elapsed_seconds + max(0, (int) $s->resumed_at->diffInSeconds(now())));
            }
            $action = $data['action'];
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
            if ($action === 'finish' || ($s->elapsed_seconds >= $s->duration_seconds && $action !== 'cancel')) {
                $s->status = 'completed';
                $s->completed_at = now();
                $s->resumed_at = null;
                if ($s->task_id && $s->kind === 'focus') {
                    Task::whereKey($s->task_id)->increment('actual_minutes', (int) floor($s->elapsed_seconds / 60));
                }
                InboxNotification::firstOrCreate(['deduplication_key' => 'focus:'.$s->id], ['user_id' => $request->user()->id, 'title' => 'Focus session completed']);
            }
            $s->save();

            return $s;
        });

        return response()->json($session);
    }
}
