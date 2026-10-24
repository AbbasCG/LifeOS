<?php

namespace App\Http\Controllers;

use App\Models\ScheduleProposal;
use App\Services\PlanningService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class PlanningController extends Controller
{
    public function generate(Request $request, PlanningService $planner): JsonResponse
    {
        $data = $request->validate(['date' => 'required|date_format:Y-m-d|after_or_equal:today', 'days' => 'required|integer|min:1|max:7']);

        return response()->json($planner->generate($request->user(), $data['date'], $data['days']), 201);
    }

    public function accept(Request $request, int $id, PlanningService $planner): JsonResponse
    {
        return response()->json($planner->accept($request->user(), $id));
    }

    public function reject(Request $request, int $id): JsonResponse
    {
        $proposal = \Illuminate\Support\Facades\DB::transaction(function () use ($request, $id) { $proposal = ScheduleProposal::where('user_id', $request->user()->id)->where('status', 'pending')->lockForUpdate()->findOrFail($id); $proposal->update(['status' => 'rejected']); return $proposal; });

        return response()->json($proposal);
    }
}

