<?php

namespace App\Services;

use App\Models\User;
use Carbon\CarbonImmutable;

/**
 * Free time on the next work days, by the same rules DayReorganizer places sessions with: inside the work hours of each work day (Ramadan hours on a
 * day of Ramadan), around everything on the calendar (LifeOS, recurring and connected calendars; the blocks of completed or cancelled tasks do not hold
 * time), with the user's break after each busy block and without the prayer and iftar windows when they are turned on.
 *
 * Used by the one-tap postpone (TaskPostponer) and the evening "Close the day" preview (DayCloser). Nothing is written.
 */
class FreeSlots
{
    /** Calendar days searched at most, whatever the number of work days asked for. */
    public const MAX_CALENDAR_DAYS = 21;

    public function __construct(private PlanningService $planning, private CalendarService $calendar) {}

    /**
     * The earliest start a new or moved block may take today: 15 minutes from now, on a 5-minute mark (as DayReorganizer).
     */
    public static function earliest(CarbonImmutable $now): CarbonImmutable
    {
        $earliest = $now->addMinutes(15)->startOfMinute();

        return $earliest->addMinutes((5 - $earliest->minute % 5) % 5);
    }

    /**
     * Free intervals of up to $workDays work days, starting with the local day $first (included when it is a work day).
     *
     * @param  array<string, mixed>  $c  PlanningService::config
     * @param  CarbonImmutable  $first  start of a local day in the account timezone
     * @param  CarbonImmutable  $notBefore  nothing starts earlier than this
     * @param  int|null  $ignoreEventId  a (non-recurring) event whose own time is free, e.g. the session being moved
     * @return list<array{local: CarbonImmutable, free: list<array{0: CarbonImmutable, 1: CarbonImmutable}>}>
     */
    public function days(User $user, array $c, CarbonImmutable $first, int $workDays, CarbonImmutable $notBefore, ?int $ignoreEventId = null): array
    {
        $first = $first->setTimezone($c['tz'])->startOfDay();
        $occurrences = $this->calendar->occurrences($user, $first->utc(), $first->addDays(self::MAX_CALENDAR_DAYS)->utc());
        $closed = $this->calendar->closedTaskIds($user, $occurrences);
        $busy = $occurrences->reject(fn (array $o) => (isset($o['task_id']) && $closed->has($o['task_id'])) || ($ignoreEventId !== null && ($o['event_id'] ?? null) === $ignoreEventId && ! ($o['recurring'] ?? false)))
            ->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->values()->all();
        $days = [];
        for ($d = 0; $d < self::MAX_CALENDAR_DAYS && count($days) < $workDays; $d++) {
            $local = $first->addDays($d);
            if (! in_array($local->dayOfWeek, $c['work_days'], true)) {
                continue;
            }
            [$ws, $we] = $this->planning->workHours($c, $local);
            $from = max($local->setTimeFromTimeString($ws), $notBefore);
            $to = $local->setTimeFromTimeString($we);
            $days[] = ['local' => $local, 'free' => $from < $to ? $this->planning->freeIntervals($from->utc(), $to->utc(), $busy, $c['break'], $c) : []];
        }

        return $days;
    }

    /**
     * Take the first free interval (earliest day first) that holds $seconds, and shrink that day's free list by the block and a break after it,
     * so several placements never overlap. Same rule as AssistantActions::takeSlot, to the second (a moved session keeps its exact length).
     *
     * @param  list<array{local: CarbonImmutable, free: list<array{0: CarbonImmutable, 1: CarbonImmutable}>}>  $days
     * @return array{0: CarbonImmutable, 1: CarbonImmutable, 2: CarbonImmutable}|null start, end (UTC) and the local day
     */
    public function take(array &$days, int $seconds, int $break): ?array
    {
        foreach ($days as $d => $day) {
            foreach ($day['free'] as $i => [$s, $e]) {
                if ($s->diffInSeconds($e) < $seconds) {
                    continue;
                }
                $slot = [$s, $s->addSeconds($seconds)];
                $rest = $slot[1]->addMinutes($break);
                if ($rest->diffInMinutes($e, false) >= 15) {
                    $days[$d]['free'][$i] = [$rest, $e];
                } else {
                    unset($days[$d]['free'][$i]);
                }
                $days[$d]['free'] = array_values($days[$d]['free']);

                return [$slot[0], $slot[1], $day['local']];
            }
        }

        return null;
    }
}
