<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\CalendarEventException;
use App\Models\User;
use Carbon\CarbonImmutable;
use Generator;
use Illuminate\Support\Collection;

/**
 * Single source of truth for "what is on the calendar between A and B".
 *
 * Recurring events are stored once with a rule and expanded on demand inside the requested window,
 * so no unbounded rows are ever created. Rules are evaluated on the series' wall clock in its own
 * timezone, so a 09:00 weekly meeting stays at 09:00 across daylight-saving changes.
 */
class CalendarService
{
    public const MAX_ITERATIONS = 20000;

    public const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];

    /** @var list<callable(User, CarbonImmutable, CarbonImmutable): iterable<array<string, mixed>>> */
    private array $sources = [];

    /**
     * Register an additional read-only source of occurrences (e.g. synced external calendars).
     *
     * @param  callable(User, CarbonImmutable, CarbonImmutable): iterable<array<string, mixed>>  $source
     */
    public function addSource(callable $source): void
    {
        $this->sources[] = $source;
    }

    /**
     * Start instants (UTC) of a series, in order, stopping before $to.
     *
     * @return Generator<int, CarbonImmutable>
     */
    public function occurrenceStarts(CalendarEvent $event, CarbonImmutable $to): Generator
    {
        $rule = $event->recurrence ?? [];
        $tz = $event->timezone ?: 'UTC';
        $first = $event->starts_at->setTimezone($tz);
        if (empty($rule['freq'])) {
            if ($first < $to) {
                yield $first->utc();
            }

            return;
        }
        $interval = max(1, (int) ($rule['interval'] ?? 1));
        $count = isset($rule['count']) ? (int) $rule['count'] : null;
        $until = ! empty($rule['until']) ? CarbonImmutable::parse($rule['until'], $tz)->endOfDay() : null;
        $weekdays = collect($rule['by_weekday'] ?? [$first->dayOfWeek])->map(fn ($d) => ((int) $d + 6) % 7)->unique()->sort()->values();
        $at = fn (CarbonImmutable $day) => $day->setTime($first->hour, $first->minute, $first->second);
        $emitted = 0;
        for ($i = 0; $i < self::MAX_ITERATIONS; $i++) {
            $candidates = match ($rule['freq']) {
                'daily' => [$at($first->startOfDay()->addDays($i * $interval))],
                'weekly' => $weekdays->map(fn (int $offset) => $at($first->startOfWeek(CarbonImmutable::MONDAY)->addWeeks($i * $interval)->addDays($offset)))->all(),
                'monthly' => (function () use ($first, $i, $interval, $at) {
                    $month = $first->startOfMonth()->addMonthsNoOverflow($i * $interval);

                    return $first->day <= $month->daysInMonth ? [$at($month->setDay($first->day))] : [];
                })(),
                'yearly' => (function () use ($first, $i, $interval, $at) {
                    $month = $first->startOfMonth()->addYearsNoOverflow($i * $interval);

                    return $first->day <= $month->daysInMonth ? [$at($month->setDay($first->day))] : [];
                })(),
                default => [],
            };
            foreach ($candidates as $candidate) {
                if ($candidate < $first) {
                    continue;
                }
                if (($until && $candidate > $until) || $candidate->utc() >= $to) {
                    return;
                }
                $emitted++;
                if ($count !== null && $emitted > $count) {
                    return;
                }
                yield $candidate->utc();
            }
        }
    }

    /**
     * Whether $start (UTC) is a genuine occurrence of the series.
     */
    public function isOccurrence(CalendarEvent $event, CarbonImmutable $start): bool
    {
        foreach ($this->occurrenceStarts($event, $start->addSecond()) as $candidate) {
            if ($candidate->equalTo($start)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Date of the last occurrence for count-limited series, or the explicit until date (for indexing).
     */
    public function lastOccurrenceDate(CalendarEvent $event): ?string
    {
        $rule = $event->recurrence ?? [];
        if (empty($rule['freq'])) {
            return null;
        }
        if (! empty($rule['until'])) {
            return $rule['until'];
        }
        if (empty($rule['count'])) {
            return null;
        }
        $last = null;
        foreach ($this->occurrenceStarts($event, CarbonImmutable::now()->addYears(200)) as $start) {
            $last = $start;
        }

        return $last?->setTimezone($event->timezone ?: 'UTC')->toDateString();
    }

    /**
     * Concrete occurrences of one event overlapping [from, to), with exceptions applied.
     *
     * @param  Collection<int, CalendarEventException>|null  $exceptions
     * @return list<array<string, mixed>>
     */
    public function expand(CalendarEvent $event, CarbonImmutable $from, CarbonImmutable $to, ?Collection $exceptions = null): array
    {
        $exceptions ??= $event->exists ? $event->exceptions()->get() : collect();
        $byStart = $exceptions->keyBy(fn (CalendarEventException $e) => $e->original_start->getTimestamp());
        $duration = (int) $event->starts_at->diffInSeconds($event->ends_at);
        $recurring = $event->isRecurring();
        $result = [];
        $seen = [];
        foreach ($this->occurrenceStarts($event, $to) as $start) {
            $exception = $byStart->get($start->getTimestamp());
            $seen[$start->getTimestamp()] = true;
            if ($exception?->cancelled) {
                continue;
            }
            $occurrence = $this->occurrence($event, $start, $start->addSeconds($duration), $exception, $recurring);
            if ($occurrence['ends_at'] > $from && $occurrence['starts_at'] < $to) {
                $result[] = $occurrence;
            }
        }
        // Occurrences moved into the window from a date outside it.
        foreach ($exceptions as $exception) {
            if ($exception->cancelled || ! $exception->starts_at || isset($seen[$exception->original_start->getTimestamp()])) {
                continue;
            }
            if ($exception->starts_at < $to && $exception->ends_at > $from && $this->isOccurrence($event, $exception->original_start)) {
                $result[] = $this->occurrence($event, $exception->original_start, $exception->original_start->addSeconds($duration), $exception, $recurring);
            }
        }

        return $result;
    }

    /**
     * @return array<string, mixed>
     */
    private function occurrence(CalendarEvent $event, CarbonImmutable $originalStart, CarbonImmutable $originalEnd, ?CalendarEventException $exception, bool $recurring): array
    {
        return [
            'id' => $recurring ? "e{$event->id}:{$originalStart->getTimestamp()}" : "e{$event->id}",
            'event_id' => $event->id,
            'source' => 'lifeos',
            'title' => $exception?->title ?? $event->title,
            'description' => $exception?->description ?? $event->description,
            'kind' => $exception?->kind ?? $event->kind,
            'task_id' => $event->task_id,
            'starts_at' => $exception?->starts_at ?? $originalStart,
            'ends_at' => $exception?->ends_at ?? $originalEnd,
            'recurring' => $recurring,
            'occurrence_start' => $recurring ? $originalStart : null,
            'is_exception' => (bool) $exception,
            'recurrence' => $event->recurrence,
            'timezone' => $event->timezone,
            'remind_minutes' => $event->remind_minutes,
            'editable' => true,
        ];
    }

    /**
     * Everything on the user's calendar overlapping [from, to), sorted by start.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function occurrences(User $user, CarbonImmutable $from, CarbonImmutable $to): Collection
    {
        $singles = CalendarEvent::where('user_id', $user->id)->whereNull('recurrence')->where('ends_at', '>', $from)->where('starts_at', '<', $to)->get();
        $series = CalendarEvent::where('user_id', $user->id)->whereNotNull('recurrence')->where('starts_at', '<', $to)
            ->where(fn ($q) => $q->whereNull('recurrence_until')->orWhere('recurrence_until', '>=', $from->subDays(2)->toDateString()))
            ->get();
        $exceptions = CalendarEventException::whereIn('calendar_event_id', $series->pluck('id'))->get()->groupBy('calendar_event_id');
        $items = collect();
        foreach ($singles as $event) {
            $items->push(...$this->expand($event, $from, $to, collect()));
        }
        foreach ($series as $event) {
            $items->push(...$this->expand($event, $from, $to, $exceptions->get($event->id, collect())));
        }
        // A connected calendar often mirrors a LifeOS block (e.g. an exported plan); keep the editable LifeOS copy only.
        $own = $items->mapWithKeys(fn (array $o) => [CalendarSyncService::fingerprint((string) $o['title'], $o['starts_at'], $o['ends_at']) => true]);
        foreach ($this->sources as $source) {
            foreach ($source($user, $from, $to) as $occurrence) {
                if (isset($own[$occurrence['fingerprint'] ?? ''])) {
                    continue;
                }
                $items->push($occurrence);
            }
        }

        return $items->sortBy(fn (array $o) => $o['starts_at']->getTimestamp())->values();
    }

    /**
     * Occurrences overlapping [start, end), optionally ignoring one event (all occurrences) or one occurrence.
     *
     * @return Collection<int, array<string, mixed>>
     */
    public function conflicts(User $user, CarbonImmutable $start, CarbonImmutable $end, ?int $ignoreEventId = null, ?CarbonImmutable $ignoreOccurrence = null): Collection
    {
        return $this->occurrences($user, $start, $end)->filter(function (array $o) use ($start, $end, $ignoreEventId, $ignoreOccurrence) {
            if ($ignoreEventId !== null && ($o['event_id'] ?? null) === $ignoreEventId && ($ignoreOccurrence === null || ($o['occurrence_start'] ?? null)?->equalTo($ignoreOccurrence))) {
                return false;
            }

            return $o['starts_at'] < $end && $o['ends_at'] > $start;
        })->values();
    }

    /**
     * Conflicts for every occurrence of a (possibly unsaved) series within the next $days days.
     *
     * @return list<array{date: string, title: string, starts_at: string}>
     */
    public function seriesConflicts(User $user, CalendarEvent $event, int $days = 90, int $limit = 5): array
    {
        $from = max($event->starts_at, CarbonImmutable::now());
        $to = $from->addDays($days);
        $existing = $this->occurrences($user, $from, $to)->filter(fn (array $o) => ! $event->exists || ($o['event_id'] ?? null) !== $event->id);
        $found = [];
        foreach ($this->expand($event, $from, $to, $event->exists ? null : collect()) as $mine) {
            $clash = $existing->first(fn (array $o) => $o['starts_at'] < $mine['ends_at'] && $o['ends_at'] > $mine['starts_at']);
            if ($clash) {
                $found[] = ['date' => $mine['starts_at']->setTimezone($event->timezone ?: 'UTC')->toDateString(), 'title' => $clash['title'], 'starts_at' => $clash['starts_at']->toIso8601String()];
                if (count($found) >= $limit) {
                    break;
                }
            }
        }

        return $found;
    }

    /**
     * JSON-friendly representation.
     *
     * @param  array<string, mixed>  $o
     * @return array<string, mixed>
     */
    public static function present(array $o): array
    {
        return array_merge($o, [
            'starts_at' => $o['starts_at']->toIso8601String(),
            'ends_at' => $o['ends_at']->toIso8601String(),
            'occurrence_start' => isset($o['occurrence_start']) ? $o['occurrence_start']->toIso8601String() : null,
        ]);
    }
}
