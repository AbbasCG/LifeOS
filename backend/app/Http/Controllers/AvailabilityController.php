<?php

namespace App\Http\Controllers;

use App\Services\CalendarService;
use App\Services\PlanningService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AvailabilityController extends Controller
{
    /**
     * Free time within working hours for each day in the range.
     */
    public function index(Request $request, PlanningService $planner, CalendarService $calendar): JsonResponse
    {
        $data = $request->validate(['date' => 'required|date_format:Y-m-d', 'days' => 'sometimes|integer|min:1|max:42', 'min_minutes' => 'sometimes|integer|min:5|max:480']);
        $c = $planner->config($request->user());
        $first = CarbonImmutable::parse($data['date'], $c['tz'])->startOfDay();
        $days = (int) ($data['days'] ?? 1);
        $minimum = (int) ($data['min_minutes'] ?? 15);
        $busy = $calendar->occurrences($request->user(), $first->utc(), $first->addDays($days)->utc())->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();
        $result = [];
        for ($d = 0; $d < $days; $d++) {
            $local = $first->addDays($d);
            $workDay = in_array($local->dayOfWeek, $c['work_days'], true);
            $start = max($local->setTimeFromTimeString($c['work_start'])->utc(), CarbonImmutable::now()->startOfMinute());
            $slots = $workDay ? $planner->freeIntervals($start, $local->setTimeFromTimeString($c['work_end'])->utc(), $busy) : [];
            $slots = array_values(array_filter($slots, fn (array $s) => $s[0]->diffInMinutes($s[1]) >= $minimum));
            $result[] = [
                'date' => $local->toDateString(),
                'work_day' => $workDay,
                'free_minutes' => (int) array_sum(array_map(fn (array $s) => $s[0]->diffInMinutes($s[1]), $slots)),
                'slots' => array_map(fn (array $s) => ['starts_at' => $s[0]->toIso8601String(), 'ends_at' => $s[1]->toIso8601String(), 'minutes' => (int) $s[0]->diffInMinutes($s[1])], $slots),
            ];
        }

        return response()->json(['work_start' => $c['work_start'], 'work_end' => $c['work_end'], 'days' => $result]);
    }
}
