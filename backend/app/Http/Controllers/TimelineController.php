<?php

namespace App\Http\Controllers;

use App\Models\CalendarEvent;
use App\Services\TimelineService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class TimelineController extends Controller
{
    /**
     * Unified timeline for a local date range (up to 31 days), optionally filtered by source, account, life area and kind.
     */
    public function index(Request $request, TimelineService $timeline): JsonResponse
    {
        $user = $request->user();
        $today = CarbonImmutable::now($user->timezone())->toDateString();
        $csv = fn (string $key) => array_values(array_filter(explode(',', (string) $request->query($key, '')), fn ($v) => $v !== ''));
        $request->merge(['_sources' => $csv('sources'), '_accounts' => $csv('accounts'), '_areas' => $csv('areas'), '_kinds' => $csv('kinds')]);
        $data = $request->validate([
            'from' => 'sometimes|date_format:Y-m-d',
            'to' => 'sometimes|date_format:Y-m-d|after_or_equal:from',
            '_sources' => 'array|max:20', '_sources.*' => 'string|max:30|regex:/^[a-z_]+$/',
            '_accounts' => 'array|max:50', '_accounts.*' => 'integer|min:0',
            '_areas' => 'array', '_areas.*' => Rule::in([...TimelineService::AREAS, 'unassigned']),
            '_kinds' => 'array', '_kinds.*' => Rule::in(TimelineService::KINDS),
        ]);
        $from = CarbonImmutable::parse($data['from'] ?? $today, $user->timezone());
        $to = CarbonImmutable::parse($data['to'] ?? $from->toDateString(), $user->timezone());
        if ($from->diffInDays($to) >= TimelineService::MAX_DAYS) {
            throw ValidationException::withMessages(['to' => ['Choose a range of at most '.TimelineService::MAX_DAYS.' days.']]);
        }

        return response()->json($timeline->build($user, $from, $to, [
            'sources' => $data['_sources'], 'accounts' => array_map('intval', $data['_accounts']), 'areas' => $data['_areas'], 'kinds' => $data['_kinds'],
        ]));
    }

    /**
     * Conflict preview for moving a LifeOS event (or one occurrence of a series). Read-only: saving goes through the
     * calendar endpoint, which re-checks conflicts and fixed commitments.
     */
    public function preview(Request $request, TimelineService $timeline): JsonResponse
    {
        $data = $request->validate([
            'event_id' => 'required|integer',
            'occurrence_start' => 'nullable|date',
            'starts_at' => 'required|date',
            'ends_at' => 'required|date|after:starts_at',
        ]);
        $event = CalendarEvent::where('user_id', $request->user()->id)->findOrFail($data['event_id']);
        $start = CarbonImmutable::parse($data['starts_at'])->utc();
        $end = CarbonImmutable::parse($data['ends_at'])->utc();
        if ($start->diffInHours($end) > 24) {
            throw ValidationException::withMessages(['ends_at' => ['Choose a slot of at most 24 hours.']]);
        }

        return response()->json($timeline->preview($request->user(), $event, isset($data['occurrence_start']) ? CarbonImmutable::parse($data['occurrence_start'])->utc() : null, $start, $end));
    }
}
