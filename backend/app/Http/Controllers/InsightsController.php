<?php

namespace App\Http\Controllers;

use App\Services\AnalyticsService;
use App\Services\BriefingService;
use App\Services\GoalIntelligence;
use App\Services\TodayService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class InsightsController extends Controller
{
    public function briefing(Request $request, BriefingService $briefing): JsonResponse
    {
        return response()->json($briefing->today($request->user()));
    }

    public function today(Request $request, TodayService $today): JsonResponse
    {
        return response()->json($today->today($request->user()));
    }

    public function analytics(Request $request, AnalyticsService $analytics): JsonResponse
    {
        $today = CarbonImmutable::now($request->user()->timezone())->toDateString();
        $data = $request->validate([
            'days' => 'sometimes|integer|in:7,14,30,90',
            'from' => 'required_with:to|date_format:Y-m-d|before_or_equal:to',
            'to' => 'required_with:from|date_format:Y-m-d|before_or_equal:'.$today,
            'project_id' => ['sometimes', 'nullable', 'integer', Rule::exists('projects', 'id')->where('user_id', $request->user()->id)],
        ]);
        if (isset($data['from']) && CarbonImmutable::parse($data['from'])->diffInDays(CarbonImmutable::parse($data['to'])) > 365) {
            throw ValidationException::withMessages(['from' => ['Choose a range of at most one year.']]);
        }

        return response()->json($analytics->summary($request->user(), (int) ($data['days'] ?? 30), $data['from'] ?? null, $data['to'] ?? null, isset($data['project_id']) ? (int) $data['project_id'] : null));
    }

    /**
     * Goal, project and habit intelligence (health, risks, next actions, trends).
     */
    public function progress(Request $request, GoalIntelligence $intelligence): JsonResponse
    {
        $user = $request->user();

        return response()->json(['goals' => $intelligence->goals($user), 'projects' => $intelligence->projects($user), 'habits' => $intelligence->habits($user)]);
    }
}
