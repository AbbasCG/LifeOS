<?php

namespace App\Http\Controllers;

use App\Models\ScheduleProposal;
use App\Services\PlanningService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class PlanningController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        return response()->json(ScheduleProposal::where('user_id', $request->user()->id)->latest()->latest('id')->limit(10)->get());
    }

    public function show(Request $request, int $id): JsonResponse
    {
        return response()->json(ScheduleProposal::where('user_id', $request->user()->id)->findOrFail($id));
    }

    public function generate(Request $request, PlanningService $planner): JsonResponse
    {
        $owned = Rule::exists('tasks', 'id')->where('user_id', $request->user()->id);
        $data = $request->validate([
            'date' => 'required|date_format:Y-m-d',
            'days' => 'required|integer|min:1|max:7',
            'task_ids' => 'sometimes|array|max:100',
            'task_ids.*' => ['integer', $owned],
            'priority_task_ids' => 'sometimes|array|max:20',
            'priority_task_ids.*' => ['integer', $owned],
        ]);
        if ($data['date'] < CarbonImmutable::now($request->user()->timezone())->toDateString()) {
            throw ValidationException::withMessages(['date' => ['Plans can start today or later.']]);
        }

        return response()->json($planner->generate($request->user(), $data['date'], $data['days'], $data['task_ids'] ?? [], $data['priority_task_ids'] ?? []), 201);
    }

    public function update(Request $request, int $id, PlanningService $planner): JsonResponse
    {
        $data = $request->validate([
            'items' => 'present|array|max:200',
            'items.*.key' => 'nullable|string|max:100',
            'items.*.task_id' => 'required|integer',
            'items.*.starts_at' => 'required|date',
            'items.*.ends_at' => 'required|date',
        ]);
        foreach ($data['items'] as $index => $item) {
            $minutes = CarbonImmutable::parse($item['starts_at'])->diffInMinutes(CarbonImmutable::parse($item['ends_at']), false);
            if ($minutes < 5 || $minutes > 480) {
                throw ValidationException::withMessages(["items.$index.ends_at" => ['Blocks must last between 5 minutes and 8 hours.']]);
            }
        }

        return response()->json($planner->update($request->user(), $id, $data['items']));
    }

    public function accept(Request $request, int $id, PlanningService $planner): JsonResponse
    {
        return response()->json($planner->accept($request->user(), $id));
    }

    public function reject(Request $request, int $id): JsonResponse
    {
        $proposal = DB::transaction(function () use ($request, $id) {
            $proposal = ScheduleProposal::where('user_id', $request->user()->id)->where('status', 'pending')->lockForUpdate()->findOrFail($id);
            $proposal->update(['status' => 'rejected']);

            return $proposal;
        });

        return response()->json($proposal);
    }

    public function missed(Request $request, PlanningService $planner): JsonResponse
    {
        return response()->json(['data' => $planner->missedBlocks($request->user())]);
    }

    public function insights(Request $request, PlanningService $planner): JsonResponse
    {
        $data = $request->validate(['from' => 'sometimes|date_format:Y-m-d', 'days' => 'sometimes|integer|min:1|max:31']);
        $tz = $request->user()->timezone();
        $from = isset($data['from']) ? CarbonImmutable::parse($data['from'], $tz) : CarbonImmutable::now($tz)->startOfWeek(CarbonImmutable::MONDAY);

        return response()->json($planner->plannedVsActual($request->user(), $from, (int) ($data['days'] ?? 7)));
    }
}
