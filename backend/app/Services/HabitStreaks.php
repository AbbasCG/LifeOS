<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

class HabitStreaks
{
    /**
     * Calculate streaks from completion dates. Daily habits count consecutive days; weekly habits count consecutive
     * weeks (starting on $weekStart, 0 = Sunday ... 6 = Saturday; Monday by default) with at least one completion. The current streak stays alive until the current period has passed.
     *
     * @param  Collection<int, string>|array<int, string>  $dates  Y-m-d completion dates
     * @return array{current_streak: int, longest_streak: int, done_today: bool, done_this_period: bool}
     */
    public function calculate(Collection|array $dates, string $recurrence, CarbonImmutable $today, int $weekStart = 1): array
    {
        $weekly = $recurrence === 'weekly';
        $todayKey = $today->toDateString();
        $periods = collect($dates)
            ->map(fn (string $date) => $this->periodKey(CarbonImmutable::parse($date), $weekly, $weekStart))
            ->unique()
            ->sort()
            ->values();
        $set = $periods->flip();
        $currentKey = $this->periodKey($today, $weekly, $weekStart);
        $cursor = $set->has($currentKey) ? $today : $this->previousPeriod($today, $weekly);
        $current = 0;
        while ($set->has($this->periodKey($cursor, $weekly, $weekStart))) {
            $current++;
            $cursor = $this->previousPeriod($cursor, $weekly);
        }
        $longest = 0;
        $run = 0;
        $previous = null;
        foreach ($periods as $key) {
            $date = CarbonImmutable::parse($key);
            $run = $previous && $this->periodKey($this->previousPeriod($date, $weekly), $weekly, $weekStart) === $previous ? $run + 1 : 1;
            $longest = max($longest, $run);
            $previous = $key;
        }

        return [
            'current_streak' => $current,
            'longest_streak' => $longest,
            'done_today' => collect($dates)->contains($todayKey),
            'done_this_period' => $set->has($currentKey),
        ];
    }

    private function periodKey(CarbonImmutable $date, bool $weekly, int $weekStart): string
    {
        return $weekly ? $date->startOfWeek($weekStart)->toDateString() : $date->toDateString();
    }

    private function previousPeriod(CarbonImmutable $date, bool $weekly): CarbonImmutable
    {
        return $weekly ? $date->subWeek() : $date->subDay();
    }
}
