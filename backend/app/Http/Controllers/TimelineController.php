<?php

namespace App\Http\Controllers;

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
}
