<?php

namespace App\Http\Controllers;

use App\Services\DayPlanner;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class DayPlanController extends Controller
{
    public function __construct(private DayPlanner $planner) {}

    /**
     * Read-only: the day's budget, explanations and alternative schedules. Nothing is saved.
     */
    public function show(Request $request): JsonResponse
    {
        $date = $this->date($request);

        return response()->json($this->planner->plan($request->user(), $date, $request->boolean('replan')));
    }

    /**
     * Save the chosen alternative as a pending proposal; the calendar changes only when the user accepts it.
     */
    public function choose(Request $request): JsonResponse
    {
        $request->validate(['variant' => ['required', Rule::in(DayPlanner::VARIANTS)]]);

        return response()->json($this->planner->choose($request->user(), $this->date($request), $request->string('variant')->toString()), 201);
    }

    private function date(Request $request): string
    {
        $today = CarbonImmutable::now($request->user()->timezone())->toDateString();
        $data = $request->validate(['date' => 'sometimes|date_format:Y-m-d|after_or_equal:'.$today.'|before_or_equal:'.CarbonImmutable::parse($today)->addDays(14)->toDateString()]);

        return $data['date'] ?? $today;
    }
}
