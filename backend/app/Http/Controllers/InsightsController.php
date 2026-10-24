<?php

namespace App\Http\Controllers;

use App\Services\AnalyticsService;
use App\Services\BriefingService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class InsightsController extends Controller
{
    public function briefing(Request $request, BriefingService $briefing): JsonResponse
    {
        return response()->json($briefing->today($request->user()));
    }

    public function analytics(Request $request, AnalyticsService $analytics): JsonResponse
    {
        $data = $request->validate(['days' => 'sometimes|integer|in:7,14,30,90']);

        return response()->json($analytics->summary($request->user(), (int) ($data['days'] ?? 30)));
    }
}
