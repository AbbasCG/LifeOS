<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Builds reviewable change proposals from real calendar availability and executes only the actions a user approves.
 * The set of action types is a fixed whitelist; every action is re-validated against current data at execution time.
 */
class AssistantActions
{
    public const ACTION_TYPES = ['create_event', 'move_event'];

    public const TTL_HOURS = 24;

    public const MAX_BLOCK_MINUTES = 480;

    public function __construct(private CalendarService $calendar, private PlanningService $planning, private AuditLogger $audit) {}

    /**
     * Place activities into the free time of one day.
     *
     * @param  list<array{title: string, minutes?: int|null, task_id?: int|null}>  $items
     */
    public function proposeSchedule(User $user, string $date, int $availableMinutes, array $items, ?string $startAfter, bool $ar, string $provider): AssistantProposal
    {
        $c = $this->planning->config($user);
        $day = CarbonImmutable::parse($date, $c['tz'])->startOfDay();
        $now = CarbonImmutable::now($c['tz']);
        $availableMinutes = max(15, min(720, $availableMinutes));
        $explanation = [];

        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get();
        if ($items === []) {
            $items = BriefingService::rank($open, $now)->take(3)->map(fn (array $row) => ['title' => $row['task']->title, 'task_id' => $row['task']->id, 'minutes' => null])->values()->all();
            $explanation[] = $ar ? 'لم تذكر أنشطة محددة، فاخترت أهم مهامك المفتوحة.' : 'You didn’t name activities, so I picked your highest-priority open tasks.';
        }
        $items = $this->matchTasks(array_slice($items, 0, 8), $open);
        $durations = $this->durations($items, $availableMinutes, $c['break']);

        $windowStart = $day->setTimeFromTimeString($startAfter ?? $c['work_start']);
        if ($day->isSameDay($now) && $windowStart < $now) {
            $windowStart = $now->addMinutes(15 - $now->minute % 15)->startOfMinute();
        }
        $needed = array_sum($durations) + $c['break'] * max(0, count($durations) - 1);
        $windowEnd = max($day->setTimeFromTimeString($c['work_end']), $windowStart->addMinutes($needed + 60));
        $windowEnd = min($windowEnd, $day->setTime(22, 0));
        $occurrences = $this->calendar->occurrences($user, $day->utc(), $day->addDay()->utc());
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();
        $free = $this->planning->freeIntervals($windowStart->utc(), $windowEnd->utc(), $busy, $c['break']);

        $actions = [];
        $skipped = [];
        foreach ($items as $index => $item) {
            $minutes = $durations[$index];
            $slot = $this->takeSlot($free, $minutes, $c['break']);
            if (! $slot) {
                $largest = collect($free)->map(fn (array $f) => (int) $f[0]->diffInMinutes($f[1]))->max() ?? 0;
                if ($largest >= 15) {
                    $minutes = (int) (floor($largest / 5) * 5);
                    $slot = $this->takeSlot($free, $minutes, $c['break']);
                    $explanation[] = $ar ? "قُصّر «{$item['title']}» إلى {$minutes} دقيقة لعدم وجود وقت كافٍ." : "Shortened “{$item['title']}” to {$minutes} minutes because there wasn’t enough free time.";
                }
            }
            if (! $slot) {
                $skipped[] = $item['title'];

                continue;
            }
            $actions[] = [
                'id' => 'a'.(count($actions) + 1),
                'type' => 'create_event',
                'title' => $item['title'],
                'task_id' => $item['task_id'],
                'starts_at' => $slot[0]->toIso8601String(),
                'ends_at' => $slot[1]->toIso8601String(),
                'minutes' => $minutes,
            ];
        }

        $busyToday = $occurrences->filter(fn (array $o) => $o['starts_at'] < $windowEnd->utc() && $o['ends_at'] > $windowStart->utc());
        $explanation[] = $busyToday->isEmpty()
            ? ($ar ? 'لا توجد التزامات أخرى في هذه الفترة.' : 'Nothing else is booked in this window.')
            : ($ar ? 'تجنّبت التزاماتك الحالية: '.$busyToday->pluck('title')->unique()->take(4)->implode('، ').'.' : 'Worked around what’s already booked: '.$busyToday->pluck('title')->unique()->take(4)->implode(', ').'.');
        if (count($actions) > 1 && $c['break'] > 0) {
            $explanation[] = $ar ? "تركت استراحة {$c['break']} دقائق بين الفترات." : "Left a {$c['break']}-minute break between blocks.";
        }
        if (collect($items)->contains(fn (array $i) => empty($i['minutes']))) {
            $explanation[] = $ar ? 'وزّعت الوقت بالتساوي على الأنشطة التي لم تحدد مدتها، مع مراعاة تقديرات المهام المرتبطة.' : 'Split time evenly across activities without a stated length, respecting linked task estimates.';
        }
        foreach (collect($items)->whereNotNull('task_id') as $item) {
            $explanation[] = $ar ? "ربطت «{$item['title']}» بمهمتك الحالية." : "Linked “{$item['title']}” to your existing task.";
        }
        if ($skipped) {
            $explanation[] = $ar ? 'لم أجد وقتاً لـ: '.implode('، ', $skipped).'.' : 'Couldn’t find time for: '.implode(', ', $skipped).'.';
        }
        $label = $day->locale($ar ? 'ar' : 'en')->translatedFormat('l j F');
        $total = (int) collect($actions)->sum('minutes');
        $summary = match (true) {
            $actions === [] => $ar ? "لا يوجد وقت فارغ كافٍ يوم {$label}. جرّب يوماً آخر أو وقتاً أقصر." : "There isn’t enough free time on {$label}. Try another day or a shorter plan.",
            default => $ar ? "اقتراح لـ {$label}: ".count($actions)." فترات بمجموع {$total} دقيقة. راجعها واختر ما تريد إضافته إلى التقويم." : "Proposed plan for {$label}: ".count($actions)." block(s), {$total} minutes in total. Review and choose what to add to your calendar.",
        };

        return $this->store($user, 'schedule', $provider, $summary, $explanation, $actions);
    }

    /**
     * Suggest moving flexible, non-recurring blocks off overloaded days in the next week to the lightest work days.
     */
    public function proposeRebalance(User $user, bool $ar, string $provider): AssistantProposal
    {
        $c = $this->planning->config($user);
        $first = CarbonImmutable::now($c['tz'])->startOfDay();
        $summary = $this->planning->summary($user, $first, 7, [], [], $c);
        $days = collect($summary['days']);
        $overloaded = $days->where('overloaded', true)->values();
        $actions = [];
        $explanation = [];
        $occurrences = $this->calendar->occurrences($user, $first->utc(), $first->addDays(7)->utc());
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();
        $now = CarbonImmutable::now();
        foreach ($overloaded as $day) {
            $explanation[] = $ar ? "يوم {$day['date']} محجوز بنسبة {$day['load_percent']}٪ من ساعات عملك." : "{$day['date']} is {$day['load_percent']}% booked against your working hours.";
            $local = CarbonImmutable::parse($day['date'], $c['tz']);
            $candidates = $occurrences->filter(fn (array $o) => ($o['source'] ?? '') === 'lifeos' && ! $o['recurring'] && $o['kind'] !== 'fixed' && $o['starts_at'] > $now
                && $o['starts_at'] >= $local->utc() && $o['starts_at'] < $local->addDay()->utc())->sortByDesc(fn (array $o) => $o['starts_at']->diffInMinutes($o['ends_at']));
            $excess = (int) ceil(($day['load_percent'] - 80) / 100 * max(1, $day['capacity_minutes']));
            foreach ($candidates as $occurrence) {
                if ($excess <= 0) {
                    break;
                }
                $minutes = (int) $occurrence['starts_at']->diffInMinutes($occurrence['ends_at']);
                foreach ($days->where('work_day', true)->where('overloaded', false)->sortBy('load_percent') as $target) {
                    if ($target['date'] === $day['date'] || $target['free_minutes'] < $minutes + $c['break']) {
                        continue;
                    }
                    $t = CarbonImmutable::parse($target['date'], $c['tz']);
                    $from = max($t->setTimeFromTimeString($c['work_start']), $now->setTimezone($c['tz'])->addMinutes(15));
                    $free = $this->planning->freeIntervals($from->utc(), $t->setTimeFromTimeString($c['work_end'])->utc(), $busy, $c['break']);
                    $slot = $this->takeSlot($free, $minutes, $c['break']);
                    if (! $slot) {
                        continue;
                    }
                    $busy[] = $slot;
                    $actions[] = [
                        'id' => 'a'.(count($actions) + 1), 'type' => 'move_event', 'event_id' => $occurrence['event_id'], 'title' => $occurrence['title'],
                        'from_starts_at' => $occurrence['starts_at']->toIso8601String(), 'from_ends_at' => $occurrence['ends_at']->toIso8601String(),
                        'starts_at' => $slot[0]->toIso8601String(), 'ends_at' => $slot[1]->toIso8601String(), 'minutes' => $minutes,
                    ];
                    $explanation[] = $ar ? "«{$occurrence['title']}» مرنة، ويوم {$target['date']} أخف ({$target['load_percent']}٪)." : "“{$occurrence['title']}” is flexible, and {$target['date']} is lighter ({$target['load_percent']}%).";
                    $excess -= $minutes;
                    break;
                }
            }
        }
        $summaryText = match (true) {
            $overloaded->isEmpty() => $ar ? 'لا يوجد يوم مزدحم خلال الأيام السبعة القادمة. توزيعك متوازن.' : 'No day in the next seven is overloaded. Your week looks balanced.',
            $actions === [] => $ar ? 'هناك أيام مزدحمة، لكن لا توجد فترات مرنة يمكن نقلها تلقائياً. فكّر في تقصير أو إلغاء بعض الالتزامات.' : 'Some days are overloaded, but there are no flexible blocks I can move safely. Consider shortening or dropping something.',
            default => $ar ? 'أقترح نقل '.count($actions).' فترة مرنة لتخفيف الأيام المزدحمة. الالتزامات الثابتة والمتكررة والخارجية لن تتغير.' : 'I suggest moving '.count($actions).' flexible block(s) to lighten overloaded days. Fixed, recurring and external events stay where they are.',
        };

        return $this->store($user, 'rebalance', $provider, $summaryText, $explanation, $actions);
    }

    /**
     * Execute the approved subset of a proposal atomically. Any invalid action aborts everything.
     *
     * @param  list<string>  $actionIds
     */
    public function apply(User $user, AssistantProposal $proposal, array $actionIds, ?Request $request = null): AssistantProposal
    {
        if (! $proposal->isOpen()) {
            throw ValidationException::withMessages(['proposal' => [$proposal->status === 'pending' ? 'This suggestion has expired. Ask the assistant again.' : 'This suggestion was already handled.']]);
        }
        $selected = collect($proposal->actions)->whereIn('id', $actionIds)->values();
        if ($selected->isEmpty() || $selected->count() !== count(array_unique($actionIds))) {
            throw ValidationException::withMessages(['action_ids' => ['Choose at least one suggested change.']]);
        }

        $results = DB::transaction(function () use ($user, $proposal, $selected) {
            $locked = AssistantProposal::whereKey($proposal->id)->lockForUpdate()->first();
            if ($locked->status !== 'pending') {
                throw ValidationException::withMessages(['proposal' => ['This suggestion was already handled.']]);
            }
            $results = $selected->map(fn (array $action) => $this->execute($user, $action))->all();
            $locked->update(['status' => 'applied', 'applied_at' => now(), 'results' => $results]);

            return $results;
        });
        $this->audit->log($user, 'ai_action_executed', $request, ['proposal' => $proposal->id, 'kind' => $proposal->kind, 'actions' => count($results)]);

        return $proposal->fresh();
    }

    public function dismiss(AssistantProposal $proposal): AssistantProposal
    {
        if ($proposal->status === 'pending') {
            $proposal->update(['status' => 'dismissed']);
        }

        return $proposal;
    }

    /**
     * @param  array<string, mixed>  $action
     * @return array<string, mixed>
     */
    private function execute(User $user, array $action): array
    {
        $fail = fn (string $message) => throw ValidationException::withMessages(['actions' => ["“{$action['title']}”: {$message}"]]);
        if (! in_array($action['type'] ?? null, self::ACTION_TYPES, true)) {
            $fail('This change is not allowed.');
        }
        $start = CarbonImmutable::parse($action['starts_at'])->utc();
        $end = CarbonImmutable::parse($action['ends_at'])->utc();
        if ($end <= $start || $start->diffInMinutes($end) > self::MAX_BLOCK_MINUTES || $start < now()->subMinutes(5)) {
            $fail('This time is no longer valid.');
        }

        if ($action['type'] === 'create_event') {
            if ($action['task_id'] && ! Task::where('user_id', $user->id)->whereKey($action['task_id'])->exists()) {
                $fail('The linked task no longer exists.');
            }
            $this->assertFree($user, $start, $end, null, $fail);
            $event = CalendarEvent::create(['user_id' => $user->id, 'task_id' => $action['task_id'] ?: null, 'title' => mb_substr($action['title'], 0, 200), 'starts_at' => $start, 'ends_at' => $end, 'kind' => 'flexible']);

            return ['action_id' => $action['id'], 'type' => 'create_event', 'event_id' => $event->id];
        }

        $event = CalendarEvent::where('user_id', $user->id)->whereKey($action['event_id'])->whereNull('recurrence')->lockForUpdate()->first();
        if (! $event || $event->kind === 'fixed') {
            $fail('This event can no longer be moved.');
        }
        if (! $event->starts_at->equalTo(CarbonImmutable::parse($action['from_starts_at']))) {
            $fail('This event changed since the suggestion was made.');
        }
        $this->assertFree($user, $start, $end, $event->id, $fail);
        $event->update(['starts_at' => $start, 'ends_at' => $end]);

        return ['action_id' => $action['id'], 'type' => 'move_event', 'event_id' => $event->id];
    }

    private function assertFree(User $user, CarbonImmutable $start, CarbonImmutable $end, ?int $ignore, callable $fail): void
    {
        $conflict = $this->calendar->conflicts($user, $start, $end, $ignore)->first();
        if ($conflict) {
            $fail("now overlaps “{$conflict['title']}”.");
        }
    }

    /**
     * @param  list<array<string, mixed>>  $actions
     * @param  list<string>  $explanation
     */
    private function store(User $user, string $kind, string $provider, string $summary, array $explanation, array $actions): AssistantProposal
    {
        AssistantProposal::where('user_id', $user->id)->where('status', 'pending')->where('expires_at', '<', now())->update(['status' => 'expired']);

        return AssistantProposal::create([
            'user_id' => $user->id, 'kind' => $kind, 'provider' => $provider, 'status' => $actions === [] ? 'dismissed' : 'pending',
            'summary' => $summary, 'explanation' => array_values(array_unique($explanation)), 'actions' => $actions, 'expires_at' => now()->addHours(self::TTL_HOURS),
        ]);
    }

    /**
     * Link activities to open tasks with a matching title.
     *
     * @param  list<array<string, mixed>>  $items
     * @param  Collection<int, Task>  $open
     * @return list<array{title: string, minutes: int|null, task_id: int|null, estimate: int|null}>
     */
    private function matchTasks(array $items, Collection $open): array
    {
        return array_map(function (array $item) use ($open) {
            $title = trim(mb_substr((string) $item['title'], 0, 200));
            $task = isset($item['task_id']) ? $open->firstWhere('id', (int) $item['task_id']) : null;
            $needle = mb_strtolower($title);
            $task ??= mb_strlen($needle) >= 3 ? $open->first(fn (Task $t) => str_contains(mb_strtolower($t->title), $needle) || str_contains($needle, mb_strtolower($t->title))) : null;

            return ['title' => $task?->title ?? (mb_strtoupper(mb_substr($title, 0, 1)).mb_substr($title, 1)), 'minutes' => isset($item['minutes']) ? (int) $item['minutes'] : null, 'task_id' => $task?->id, 'estimate' => $task?->estimated_minutes];
        }, $items);
    }

    /**
     * Respect stated lengths; share what remains evenly (capped by linked task estimates), in 15-minute steps.
     *
     * @param  list<array{minutes: int|null, estimate: int|null}>  $items
     * @return list<int>
     */
    private function durations(array $items, int $available, int $break): array
    {
        $budget = max(15 * count($items), $available - $break * max(0, count($items) - 1));
        $fixed = array_sum(array_map(fn (array $i) => $i['minutes'] ?? 0, $items));
        $open = count(array_filter($items, fn (array $i) => empty($i['minutes'])));
        $share = $open ? max(15, (int) (floor(max(0, $budget - $fixed) / $open / 5) * 5)) : 0;
        $durations = array_map(fn (array $i) => (int) max(15, min(self::MAX_BLOCK_MINUTES, $i['minutes'] ?: ($i['estimate'] ? min($share, $i['estimate']) : $share))), $items);
        $total = array_sum($durations);
        if ($total > $budget) {
            $durations = array_map(fn (int $d) => (int) max(15, floor($d * $budget / $total / 5) * 5), $durations);
        }

        return $durations;
    }

    /**
     * Take the first free interval that fits and shrink the free list.
     *
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $free
     * @return array{0: CarbonImmutable, 1: CarbonImmutable}|null
     */
    private function takeSlot(array &$free, int $minutes, int $break): ?array
    {
        foreach ($free as $i => [$s, $e]) {
            if ($s->diffInMinutes($e) >= $minutes) {
                $slot = [$s, $s->addMinutes($minutes)];
                $rest = $slot[1]->addMinutes($break);
                if ($rest->diffInMinutes($e, false) >= 15) {
                    $free[$i] = [$rest, $e];
                } else {
                    unset($free[$i]);
                }
                $free = array_values($free);

                return $slot;
            }
        }

        return null;
    }
}
