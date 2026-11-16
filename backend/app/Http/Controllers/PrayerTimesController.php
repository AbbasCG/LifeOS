<?php

namespace App\Http\Controllers;

use App\Services\PrayerTimes;
use App\Services\Ramadan;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class PrayerTimesController extends Controller
{
    /**
     * Prayer times, the soft prayer windows and the iftar window for a run of local days. Read-only and per account; the
     * coordinates are used to compute and are not part of the response.
     */
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate(['from' => 'sometimes|date_format:Y-m-d', 'days' => 'sometimes|integer|min:1|max:42']);
        $user = $request->user();
        $prefs = $user->preferences();
        $prayer = PrayerTimes::fromPrefs($prefs);
        if (! $prayer->enabled()) {
            return response()->json(['enabled' => false, 'days' => []]);
        }
        $first = CarbonImmutable::parse($data['from'] ?? CarbonImmutable::now($prayer->timezone())->toDateString(), $prayer->timezone())->startOfDay();
        $iso = fn (CarbonImmutable $at): string => $at->utc()->format('Y-m-d\TH:i:s\Z');
        $days = [];
        for ($d = 0; $d < (int) ($data['days'] ?? 1); $d++) {
            $date = $first->addDays($d)->toDateString();
            $times = $prayer->times($date);
            $iftar = $prayer->iftar($date);
            $days[] = [
                'date' => $date,
                'ramadan' => Ramadan::activeFor($prefs, $date),
                // No times (and no windows) on a day the sun does not rise or set at this latitude.
                'times' => collect(['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'])->mapWithKeys(fn (string $name) => [$name => $times ? $iso($times[$name]) : null])->all(),
                'windows' => array_map(fn (array $w) => ['prayer' => $w['prayer'], 'prayers' => $w['prayers'], 'starts_at' => $iso($w['starts_at']), 'ends_at' => $iso($w['ends_at'])], $prayer->windows($date)),
                'iftar' => $iftar ? ['starts_at' => $iso($iftar['starts_at']), 'ends_at' => $iso($iftar['ends_at'])] : null,
            ];
        }

        return response()->json(['enabled' => true, 'timezone' => $prayer->timezone(), 'method' => $prayer->method(), 'days' => $days]);
    }
}
