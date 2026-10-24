<?php

namespace App\Http\Controllers;

use App\Models\DailyCheckin;
use App\Services\AuditLogger;
use App\Services\CheckinService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class CheckinController extends Controller
{
    public const BACKFILL_DAYS = 30;

    public function __construct(private CheckinService $checkins) {}

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $days = min(366, max(1, $request->integer('days', 30)));
        $today = CarbonImmutable::now($user->timezone())->toDateString();

        return response()->json([
            'enabled' => CheckinService::enabled($user),
            'today' => $this->checkins->forDate($user, $today)?->present(),
            'items' => DailyCheckin::where('user_id', $user->id)->where('date', '>', CarbonImmutable::parse($today)->subDays($days)->toDateString())->orderByDesc('date')->get()->map->present()->values(),
        ]);
    }

    public function upsert(Request $request, string $date): JsonResponse
    {
        $user = $request->user();
        if (! CheckinService::enabled($user)) {
            throw ValidationException::withMessages(['checkins' => ['Daily check-ins are turned off in your settings.']]);
        }
        $today = CarbonImmutable::now($user->timezone())->startOfDay();
        $day = $this->day($date, $user->timezone());
        if ($day > $today || $day < $today->subDays(self::BACKFILL_DAYS)) {
            throw ValidationException::withMessages(['date' => ['You can check in for today or up to 30 days back.']]);
        }
        $scale = 'nullable|integer|min:1|max:5';
        $data = $request->validate(['energy' => $scale, 'mood' => $scale, 'stress' => $scale, 'workload' => $scale, 'sleep_minutes' => 'nullable|integer|min:0|max:1440', 'reflection' => 'nullable|string|max:2000']);
        if (collect($data)->filter(fn ($v) => $v !== null && $v !== '')->isEmpty()) {
            throw ValidationException::withMessages(['checkin' => ['Fill in at least one field.']]);
        }
        $checkin = DailyCheckin::updateOrCreate(['user_id' => $user->id, 'date' => $day->toDateString()], $data);

        return response()->json($checkin->present(), $checkin->wasRecentlyCreated ? 201 : 200);
    }

    public function destroy(Request $request, string $date): JsonResponse
    {
        DailyCheckin::where('user_id', $request->user()->id)->whereDate('date', $this->day($date)->toDateString())->delete();

        return response()->json(['message' => 'Check-in deleted.']);
    }

    /**
     * Delete the user's whole check-in history (requires a recent password confirmation).
     */
    public function destroyAll(Request $request, AuditLogger $audit): JsonResponse
    {
        $deleted = DailyCheckin::where('user_id', $request->user()->id)->delete();
        $audit->log($request->user(), 'checkins_deleted', $request, ['count' => $deleted]);

        return response()->json(['message' => 'All check-ins deleted.', 'deleted' => $deleted]);
    }

    public function insights(Request $request): JsonResponse
    {
        return response()->json($this->checkins->insights($request->user(), min(365, max(14, $request->integer('days', 60)))));
    }

    private function day(string $date, string $timezone = 'UTC'): CarbonImmutable
    {
        abort_unless(preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) === 1 && checkdate((int) substr($date, 5, 2), (int) substr($date, 8, 2), (int) substr($date, 0, 4)), 404);

        return CarbonImmutable::parse($date, $timezone)->startOfDay();
    }
}
