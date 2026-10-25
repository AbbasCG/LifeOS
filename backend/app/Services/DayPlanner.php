<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

/**
 * Adaptive, explainable planning for a single day. It reads the real calendar (including recurring and imported
 * events), respects work/study/personal boundaries, adds buffers around commitments, adapts to the user's energy
 * check-in and peak focus hours, stretches estimates by the user's measured accuracy, recovers missed work and
 * offers alternative schedules. It never writes to the calendar: a chosen variant becomes a pending proposal that
 * the user approves through the existing accept flow.
 */
class DayPlanner
{
    public const VARIANTS = ['balanced', 'deep', 'light', 'deadlines'];

    /** Interruptions are reported in whole minutes, up to a full day. */
    public const MAX_LOST_MINUTES = 600;

    public const LONG_STRETCH = 90;

    public function __construct(private PlanningService $planning, private CalendarService $calendar, private GoalIntelligence $goals, private FocusInsights $focus) {}

    /**
     * @return array<string, mixed>
     */
    /**
     * @param  array{busy_until?: string|null, lost_minutes?: int|null}  $interruption  what changed since the day started:
     *                                                                                  busy until a time, and/or time lost
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $reserved  extra busy time (e.g. where proposed moves would go)
     */
    public function plan(User $user, string $date, bool $replan = false, array $interruption = [], array $reserved = []): array
    {
        $c = $this->planning->config($user);
        $day = CarbonImmutable::parse($date, $c['tz'])->startOfDay();
        $now = CarbonImmutable::now($c['tz']);
        $earliest = $day->isSameDay($now) ? $now->addMinutes(15 - $now->minute % 15)->startOfMinute() : $day;
        $busyUntil = ! empty($interruption['busy_until']) ? $day->setTimeFromTimeString($interruption['busy_until']) : null;
        if ($busyUntil && $busyUntil > $earliest) {
            $earliest = $busyUntil;
        }
        $lost = min(self::MAX_LOST_MINUTES, max(0, (int) ($interruption['lost_minutes'] ?? 0)));
        $windows = collect($this->planning->windows($c, $day))->map(fn (array $w) => [max($w[0], $earliest), $w[1]])->filter(fn (array $w) => $w[1]->diffInMinutes($w[0], true) >= 15 && $w[1] > $w[0])->all();

        $occurrences = $this->calendar->occurrences($user, $day->utc(), $day->addDay()->utc());
        // Buffers go around commitments (meetings, appointments, imported events), not around your own task blocks.
        $busy = $occurrences->map(function (array $o) use ($c) {
            $isTaskBlock = ($o['source'] ?? 'lifeos') === 'lifeos' && ! empty($o['task_id']);

            return [$isTaskBlock ? $o['starts_at'] : $o['starts_at']->subMinutes($c['buffer']), $isTaskBlock ? $o['ends_at'] : $o['ends_at']->addMinutes($c['buffer'])];
        })->merge($reserved)->all();
        $free = collect($windows)->map(fn (array $w) => $this->planning->freeIntervals($w[0]->utc(), $w[1]->utc(), $busy))->all();
        $freeMinutes = (int) collect($free)->flatten(1)->sum(fn (array $f) => $f[0]->diffInMinutes($f[1]));
        $windowMinutes = (int) collect($windows)->sum(fn (array $w) => $w[0]->diffInMinutes($w[1]));
        $committed = (int) $occurrences->sum(function (array $o) use ($windows) {
            return collect($windows)->sum(fn (array $w) => max(0, min($o['ends_at'], $w[1]->utc())->getTimestamp() - max($o['starts_at'], $w[0]->utc())->getTimestamp()) / 60);
        });

        $energy = CheckinService::enabled($user) ? $this->energy($user, $day) : null;
        $capacityFactor = match (true) {
            $energy === null => 1.0, $energy <= 2 => 0.7, $energy === 3 => 0.85, default => 1.0
        };
        $peak = $this->peakWindow($user, $c);
        $ratio = $this->estimateRatio($user);
        $candidates = $this->candidates($user, $c, $day, $ratio);
        $mustDo = $candidates->where('must', true);
        $mustMinutes = (int) $mustDo->sum('minutes');
        $capacity = (int) floor($freeMinutes * $capacityFactor);
        if ($c['daily_limit']) {
            $capacity = min($capacity, $c['daily_limit']);
        }
        $capacity = max(0, $capacity - $lost);

        $context = compact('c', 'day', 'free', 'peak', 'capacity');
        $alternatives = [
            $this->variant('balanced', $candidates, $context, $energy),
            $this->variant('deep', $candidates, $context, $energy),
            $this->variant('light', $candidates, $context + ['capacity' => (int) floor($capacity * 0.6)], $energy),
            $this->variant('deadlines', $candidates, $context, $energy),
        ];
        $preferred = IntelligenceSettings::feature($user, 'planner') ? IntelligenceSettings::for($user)['planning_strategy'] : null;
        $nearDeadlines = $candidates->contains(fn ($t) => $t['task']->due_at && $t['task']->due_at <= $day->addDays(2)->utc());
        $recommended = match (true) {
            $energy !== null && $energy <= 2 => 'light',
            $preferred !== null && in_array($preferred, self::VARIANTS, true) => $preferred,
            $replan && $nearDeadlines => 'deadlines',
            $peak && $candidates->contains(fn ($t) => $t['minutes'] >= 90) => 'deep',
            default => 'balanced',
        };

        $explanation = [];
        if ($busyUntil) {
            $explanation[] = ['en' => 'Re-planned from '.$busyUntil->format('H:i').' because you are busy until then.', 'ar' => 'أُعيد التخطيط بدءاً من '.$busyUntil->format('H:i').' لأنك مشغول حتى ذلك الوقت.'];
        }
        if ($lost > 0) {
            $explanation[] = ['en' => sprintf('%s lost to an interruption is taken off today\'s capacity.', $this->duration($lost, false)), 'ar' => sprintf('خُصم %s ضاع بسبب مقاطعة من سعة اليوم.', $this->duration($lost, true))];
        }
        if ($recommended === $preferred && $preferred !== null) {
            $explanation[] = ['en' => 'Your preferred planning strategy is suggested first.', 'ar' => 'تُقترح استراتيجية التخطيط المفضلة لديك أولاً.'];
        }
        $explanation[] = ['en' => sprintf('%s of free time inside your boundaries after commitments and %d-minute buffers.', $this->duration($freeMinutes, false), $c['buffer']), 'ar' => sprintf('%s وقت متاح ضمن حدودك بعد الالتزامات وفواصل %d دقائق.', $this->duration($freeMinutes, true), $c['buffer'])];
        if ($energy !== null) {
            $explanation[] = $energy <= 2
                ? ['en' => "You rated your energy {$energy}/5, so plans use about 70% of your free time and shorter blocks.", 'ar' => "قيّمت طاقتك {$energy}/5، لذا تستخدم الخطط نحو ٧٠٪ من وقتك المتاح وفترات أقصر."]
                : ['en' => "Your energy check-in ({$energy}/5) is taken into account.", 'ar' => "أُخذ تسجيل طاقتك ({$energy}/5) بعين الاعتبار."];
        }
        if ($peak) {
            $explanation[] = ['en' => sprintf('Demanding work goes into your peak focus hours (%s–%s), based on %s.', $peak[0], $peak[1], $peak[2] === 'history' ? 'your focus history' : 'your focus-hour setting'), 'ar' => sprintf('يوضع العمل الصعب في ساعات ذروة تركيزك (%s–%s)، استناداً إلى %s.', $peak[0], $peak[1], $peak[2] === 'history' ? 'سجل تركيزك' : 'إعداد ساعات التركيز')];
        }
        if (abs($ratio - 1) >= 0.05) {
            $explanation[] = ['en' => sprintf('Your tasks usually take %.2f× their estimate, so blocks are sized accordingly.', $ratio), 'ar' => sprintf('تستغرق مهامك عادةً %.2f× من تقديرها، لذا حُددت الفترات وفقاً لذلك.', $ratio)];
        }

        $missed = $this->planning->missedBlocks($user);
        $overloaded = $mustMinutes > $capacity;

        return [
            'date' => $day->toDateString(),
            'timezone' => $c['tz'],
            'replan' => $replan,
            'interruption' => ['busy_until' => $busyUntil?->format('H:i'), 'lost_minutes' => $lost],
            'budget' => ['window_minutes' => $windowMinutes, 'committed_minutes' => $committed, 'free_minutes' => $freeMinutes, 'capacity_minutes' => $capacity, 'must_do_minutes' => $mustMinutes, 'buffer_minutes' => $c['buffer']],
            'boundaries' => collect($windows)->map(fn (array $w) => ['start' => $w[0]->format('H:i'), 'end' => $w[1]->format('H:i')])->all(),
            'energy' => $energy,
            'peak' => $peak ? ['start' => $peak[0], 'end' => $peak[1], 'source' => $peak[2]] : null,
            'estimate_ratio' => round($ratio, 2),
            'commitments' => $occurrences->map(fn (array $o) => ['title' => $o['title'], 'kind' => $o['kind'], 'source' => $o['source'] ?? 'lifeos', 'recurring' => $o['recurring'] ?? false, 'starts_at' => $o['starts_at']->toIso8601String(), 'ends_at' => $o['ends_at']->toIso8601String()])->values(),
            'overload' => $overloaded ? [
                'en' => sprintf('Must-do work needs %s but only %s fits. Move or drop flexible items, or renegotiate a deadline.', $this->duration($mustMinutes, false), $this->duration($capacity, false)),
                'ar' => sprintf('تحتاج المهام الضرورية %s لكن المتاح %s فقط. انقل أو احذف عناصر مرنة، أو أعد التفاوض على موعد.', $this->duration($mustMinutes, true), $this->duration($capacity, true)),
                'flexible_events' => $occurrences->filter(fn (array $o) => ($o['source'] ?? '') === 'lifeos' && $o['kind'] !== 'fixed' && ! ($o['recurring'] ?? false))->map(fn (array $o) => ['event_id' => $o['event_id'], 'title' => $o['title'], 'starts_at' => $o['starts_at']->toIso8601String()])->values(),
            ] : null,
            'recovery' => $missed->map(fn (array $m) => ['task_id' => $m['task_id'], 'title' => $m['title'], 'missed_at' => $m['starts_at']])->values(),
            'explanation' => $explanation,
            'recommended' => $recommended,
            'alternatives' => $alternatives,
        ];
    }

    /**
     * Turn the chosen variant into a pending proposal (the calendar is only changed when the user accepts it).
     */
    /**
     * @param  array{busy_until?: string|null, lost_minutes?: int|null}  $interruption  the same interruption the user previewed
     */
    public function choose(User $user, string $date, string $variant, array $interruption = []): ScheduleProposal
    {
        $plan = $this->plan($user, $date, false, $interruption);
        $chosen = collect($plan['alternatives'])->firstWhere('key', $variant);
        if (! $chosen || $chosen['items'] === []) {
            throw ValidationException::withMessages(['variant' => ['This plan has nothing to schedule. Try another option or free up time.']]);
        }
        ScheduleProposal::where('user_id', $user->id)->where('status', 'pending')->where('days', 1)->where('starts_on', $plan['date'])->update(['status' => 'rejected']);
        $c = $this->planning->config($user);

        return ScheduleProposal::create([
            'user_id' => $user->id, 'status' => 'pending', 'starts_on' => $plan['date'], 'days' => 1, 'items' => $chosen['items'], 'warnings' => $chosen['warnings'],
            'summary' => $this->planning->summary($user, CarbonImmutable::parse($plan['date'], $c['tz']), 1, $chosen['items'], $chosen['warnings'], $c) + ['variant' => $variant, 'explanation' => array_merge($plan['explanation'], $chosen['explanation'])],
        ]);
    }

    /**
     * @param  Collection<int, array<string, mixed>>  $candidates
     * @param  array<string, mixed>  $ctx
     * @return array<string, mixed>
     */
    private function variant(string $key, Collection $candidates, array $ctx, ?int $energy): array
    {
        $c = $ctx['c'];
        $free = collect($ctx['free'])->map(fn (array $intervals) => array_values($intervals))->all();
        $budget = $ctx['capacity'];
        $block = $key === 'deep' ? 90 : (($energy !== null && $energy <= 2) || $key === 'light' ? min(45, $c['block']) : $c['block']);
        $pool = match ($key) {
            'deep' => $candidates->sortByDesc(fn ($t) => ($t['must'] ? 1000 : 0) + ($t['minutes'] >= 60 ? 500 : 0) + $t['score'])->values(),
            'light' => $candidates->filter(fn ($t) => $t['must'] || $t['score'] >= 40)->sortByDesc(fn ($t) => ($t['must'] ? 1000 : 0) + $t['score'])->values(),
            // Earliest deadline first; tasks without a deadline follow by score.
            'deadlines' => $candidates->sortBy(fn ($t) => [$t['task']->due_at?->getTimestamp() ?? PHP_INT_MAX, -$t['score']])->values(),
            default => $candidates->sortByDesc(fn ($t) => ($t['must'] ? 1000 : 0) + $t['score'])->values(),
        };
        $items = [];
        $warnings = [];
        $used = 0;
        $usedByArea = [];
        foreach ($pool as $t) {
            $need = $t['minutes'];
            $parts = [];
            // Study and personal time have their own optional daily limits on top of the overall budget.
            $area = $this->resolveArea($free, $t['area']);
            $areaLimit = $area !== null && $area !== 'work' ? ($c["{$area}_limit"] ?? null) : null;
            while ($need >= 15 && $used < $budget && count($parts) < PlanningService::MAX_BLOCKS_PER_TASK_PER_DAY) {
                $size = (int) min($need, $block, $budget - $used, $areaLimit === null ? PHP_INT_MAX : $areaLimit - ($usedByArea[$area] ?? 0));
                if ($size < 15) {
                    break;
                }
                $preferPeak = $ctx['peak'] && ($key === 'deep' || $t['minutes'] >= 60 || in_array($t['task']->priority, ['urgent', 'high'], true));
                $slot = $this->take($free, $t['area'], $size, $t['task']->due_at, $preferPeak ? $ctx['peak'] : null, $c);
                if (! $slot && $size > 30) {
                    // Shrink the block to the largest remaining gap (at least 30 minutes) rather than skipping the task.
                    $largest = $this->largestGap($free, $t['area']);
                    $size = (int) (floor(min($size, $largest) / 5) * 5);
                    $slot = $size >= 30 ? $this->take($free, $t['area'], $size, $t['task']->due_at, null, $c) : null;
                }
                if (! $slot) {
                    break;
                }
                $parts[] = $slot;
                $need -= $size;
                $used += $size;
                $usedByArea[$area] = ($usedByArea[$area] ?? 0) + $size;
            }
            foreach ($parts as $i => [$start, $end, $inPeak]) {
                $reasons = $t['reasons'];
                if ($inPeak) {
                    $reasons[] = 'focus_window';
                }
                $items[] = [
                    'key' => $t['task']->id.'-'.($i + 1).'-'.$start->getTimestamp(), 'task_id' => $t['task']->id, 'task_version' => $t['task']->updated_at->toISOString(),
                    'title' => $t['task']->title, 'priority' => $t['task']->priority, 'starts_at' => $start->utc()->toIso8601String(), 'ends_at' => $end->utc()->toIso8601String(),
                    'minutes' => (int) $start->diffInMinutes($end), 'part' => $i + 1, 'parts' => count($parts), 'manual' => false, 'area' => $area ?? 'work', 'estimate_factor' => $t['factor'],
                    'reasons' => array_values(array_unique($reasons)), 'explanation' => $this->why($t, $inPeak, $i + 1, count($parts)),
                ];
            }
            if ($t['must'] && $need >= 15) {
                $warnings[] = ['task_id' => $t['task']->id, 'title' => $t['task']->title, 'priority' => $t['task']->priority, 'needed_minutes' => (int) $need, 'due_at' => $t['task']->due_at?->toIso8601String(),
                    'reason' => 'Not enough free time today inside its boundary.', 'reason_ar' => 'لا يوجد وقت كافٍ اليوم ضمن حدودها.', 'alternatives' => [['type' => 'deadline', 'en' => 'Move the deadline or ask for more time.', 'ar' => 'انقل الموعد أو اطلب وقتاً إضافياً.'], ['type' => 'manual', 'en' => 'Add a block manually, even outside your usual hours.', 'ar' => 'أضف فترة يدوياً ولو خارج ساعاتك المعتادة.']]];
            }
        }
        usort($items, fn ($a, $b) => strcmp($a['starts_at'], $b['starts_at']));
        $breaks = $this->breaks($items);
        $switches = max(0, count(array_unique(array_column($items, 'task_id'))) - 1);
        $titles = ['balanced' => ['Balanced', 'متوازن'], 'deep' => ['Deep focus first', 'التركيز العميق أولاً'], 'light' => ['Light day', 'يوم خفيف'], 'deadlines' => ['Deadlines first', 'المواعيد النهائية أولاً']];
        $descriptions = [
            'balanced' => ['Your priorities in order, in focus-sized blocks with breaks.', 'أولوياتك بالترتيب في فترات تركيز مع استراحات.'],
            'deep' => ['Longer 90-minute blocks for your biggest work in your peak hours; fewer context switches.', 'فترات أطول (٩٠ دقيقة) لأكبر أعمالك في ساعات ذروتك مع تنقل أقل.'],
            'light' => ['Only must-dos and top priorities, using about 60% of your capacity.', 'المهام الضرورية والأولويات العليا فقط، بنحو ٦٠٪ من طاقتك.'],
            'deadlines' => ['Work in order of due date, so the nearest deadlines get time first.', 'العمل بترتيب المواعيد النهائية، فتحصل الأقرب على الوقت أولاً.'],
        ];
        $planned = (int) array_sum(array_column($items, 'minutes'));

        return [
            'key' => $key, 'title' => ['en' => $titles[$key][0], 'ar' => $titles[$key][1]], 'description' => ['en' => $descriptions[$key][0], 'ar' => $descriptions[$key][1]],
            'items' => $items, 'warnings' => $warnings, 'breaks' => $breaks,
            'metrics' => ['planned_minutes' => $planned, 'tasks' => count(array_unique(array_column($items, 'task_id'))), 'switches' => $switches, 'load_percent' => $ctx['capacity'] ? (int) round($planned / max(1, $ctx['capacity']) * 100) : 0, 'unscheduled_must_do' => count($warnings)],
            'explanation' => array_values(array_filter([
                $warnings ? ['en' => count($warnings).' must-do task(s) do not fit — see the list below.', 'ar' => count($warnings).' مهمة ضرورية لا تتسع — انظر القائمة أدناه.'] : null,
                $breaks ? ['en' => count($breaks).' break(s) suggested after long stretches of work.', 'ar' => 'اقتراح '.count($breaks).' استراحة بعد فترات عمل طويلة.'] : null,
            ])),
        ];
    }

    /**
     * Take the earliest fitting slot (in the peak window first when asked), finishing before the task's deadline.
     *
     * @param  array<string, list<array{0: CarbonImmutable, 1: CarbonImmutable}>>  $free
     * @param  array{0: string, 1: string, 2: string}|null  $peak
     * @param  array<string, mixed>  $c
     * @return array{0: CarbonImmutable, 1: CarbonImmutable, 2: bool}|null
     */
    private function take(array &$free, string $area, int $minutes, ?CarbonImmutable $due, ?array $peak, array $c): ?array
    {
        $area = $this->resolveArea($free, $area);
        if ($area === null) {
            return null;
        }
        $candidates = [];
        foreach ($free[$area] as $i => [$s, $e]) {
            $local = $s->setTimezone($c['tz']);
            if ($peak) {
                $pStart = $local->setTimeFromTimeString($peak[0])->utc();
                $pEnd = $local->setTimeFromTimeString($peak[1])->utc();
                $start = max($s, $pStart);
                if ($start->addMinutes($minutes) <= min($e, $pEnd)) {
                    $candidates[] = [$i, $start, true];
                }
            }
            if ($s->addMinutes($minutes) <= $e) {
                $candidates[] = [$i, $s, false];
            }
        }
        usort($candidates, fn ($a, $b) => [$b[2], $a[1]->getTimestamp()] <=> [$a[2], $b[1]->getTimestamp()]);
        foreach ($candidates as [$i, $start, $inPeak]) {
            $end = $start->addMinutes($minutes);
            if ($due && $end > $due && $due->isFuture()) {
                continue;
            }
            [$s, $e] = $free[$area][$i];
            $pieces = array_values(array_filter([[$s, $start], [$end->addMinutes($c['break']), $e]], fn ($p) => $p[0]->diffInMinutes($p[1], false) >= 15));
            array_splice($free[$area], $i, 1, $pieces);

            return [$start, $end, $inPeak];
        }

        return null;
    }

    /**
     * @param  array<string, list<array{0: CarbonImmutable, 1: CarbonImmutable}>>  $free
     */
    private function largestGap(array $free, string $area): int
    {
        $area = $this->resolveArea($free, $area);

        return $area === null ? 0 : (int) collect($free[$area])->max(fn (array $f) => $f[0]->diffInMinutes($f[1]));
    }

    /**
     * The window a task of this area is planned in: its own window when the user has one today, else working hours.
     *
     * @param  array<string, mixed>  $free
     */
    private function resolveArea(array $free, string $area): ?string
    {
        return isset($free[$area]) ? $area : (isset($free['work']) ? 'work' : array_key_first($free));
    }

    /**
     * Suggest a break after each continuous stretch of 90+ minutes.
     *
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private function breaks(array $items): array
    {
        $breaks = [];
        $stretch = 0;
        foreach ($items as $i => $item) {
            $stretch += $item['minutes'];
            $next = $items[$i + 1] ?? null;
            $gap = $next ? CarbonImmutable::parse($item['ends_at'])->diffInMinutes(CarbonImmutable::parse($next['starts_at'])) : null;
            if ($next && $gap < 15) {
                continue;
            }
            if ($stretch >= self::LONG_STRETCH) {
                $breaks[] = ['at' => $item['ends_at'], 'minutes' => $stretch >= 150 ? 20 : 15, 'en' => 'Take a proper break — walk, stretch, drink water.', 'ar' => 'خذ استراحة حقيقية — امشِ وتمدد واشرب الماء.'];
            }
            $stretch = 0;
        }

        return $breaks;
    }

    /**
     * Open tasks with remaining work for this day, ranked with goal pressure; missed blocks are recovered first.
     *
     * @param  array<string, mixed>  $c
     * @return Collection<int, array<string, mixed>>
     */
    private function candidates(User $user, array $c, CarbonImmutable $day, float $ratio): Collection
    {
        $tasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get();
        $areas = Category::where('user_id', $user->id)->pluck('area', 'id');
        $future = CalendarEvent::where('user_id', $user->id)->whereNotNull('task_id')->whereNull('recurrence')->where('starts_at', '>=', now())->get(['task_id', 'starts_at', 'ends_at'])
            ->groupBy('task_id')->map(fn ($events) => (int) $events->sum(fn ($e) => $e->starts_at->diffInMinutes($e->ends_at)));
        $missed = $this->planning->missedBlocks($user)->pluck('task_id')->unique()->flip();
        $endOfTomorrow = $day->addDays(2)->utc();

        return BriefingService::rank($tasks, $day->setTime(12, 0), $this->goals->pressure($user))->map(function (array $row) use ($areas, $future, $missed, $ratio, $endOfTomorrow) {
            $task = $row['task'];
            $remaining = max(0, $task->estimated_minutes - $task->actual_minutes - ($future[$task->id] ?? 0));
            $reasons = $row['reasons'];
            $score = $row['score'];
            if ($missed->has($task->id)) {
                $reasons[] = 'rescheduled';
                $score += 45;
            }

            return ['task' => $task, 'score' => $score, 'reasons' => $reasons, 'area' => $areas[$task->category_id] ?? 'work', 'factor' => round($ratio, 2),
                'minutes' => (int) (ceil($remaining * $ratio / 5) * 5),
                'must' => $missed->has($task->id) || ($task->due_at && $task->due_at <= $endOfTomorrow) || $task->priority === 'urgent'];
        })->filter(fn ($t) => $t['minutes'] >= 15)->values();
    }

    private function energy(User $user, CarbonImmutable $day): ?int
    {
        return app(CheckinService::class)->forDate($user, $day->toDateString())?->energy;
    }

    /**
     * Peak focus window from the last 30 days of focus (best two consecutive hours), else the focus-hours setting.
     *
     * @param  array<string, mixed>  $c
     * @return array{0: string, 1: string, 2: string}|null
     */
    private function peakWindow(User $user, array $c): ?array
    {
        $byHour = $this->focus->summary($user, 30)['by_hour'];
        if (array_sum($byHour) >= 240) {
            $best = 0;
            $bestHour = 0;
            for ($h = 6; $h < 21; $h++) {
                if ($best < $byHour[$h] + $byHour[$h + 1]) {
                    $best = $byHour[$h] + $byHour[$h + 1];
                    $bestHour = $h;
                }
            }

            return [sprintf('%02d:00', $bestHour), sprintf('%02d:00', $bestHour + 2), 'history'];
        }

        return $c['focus_start'] && $c['focus_end'] ? [$c['focus_start'], $c['focus_end'], 'settings'] : null;
    }

    /**
     * How long tasks really take compared with their estimates (completed in the last 90 days), clamped to 0.8–1.5.
     */
    public function estimateRatio(User $user): float
    {
        $done = Task::where('user_id', $user->id)->where('status', 'completed')->where('completed_at', '>=', now()->subDays(90))->where('actual_minutes', '>', 0)->where('estimated_minutes', '>', 0)->get(['estimated_minutes', 'actual_minutes']);
        if ($done->count() < 5) {
            return 1.0;
        }

        return (float) min(1.5, max(0.8, $done->sum('actual_minutes') / max(1, $done->sum('estimated_minutes'))));
    }

    /**
     * @param  array<string, mixed>  $t
     * @return array{en: string, ar: string}
     */
    private function why(array $t, bool $inPeak, int $part, int $parts): array
    {
        $labels = ['urgent' => ['urgent', 'عاجلة'], 'high' => ['high priority', 'أولوية عالية'], 'overdue' => ['overdue', 'متأخرة'], 'due_today' => ['due within a day', 'مستحقة خلال يوم'], 'due_soon' => ['due soon', 'مستحقة قريباً'], 'in_progress' => ['already in progress', 'قيد التنفيذ'], 'goal' => ['moves a goal that needs attention', 'تدفع هدفاً يحتاج اهتماماً'], 'rescheduled' => ['recovering a missed block', 'استعادة لفترة فائتة'], 'quick_win' => ['a quick win', 'إنجاز سريع']];
        $en = collect($t['reasons'])->map(fn ($r) => $labels[$r][0] ?? null)->filter()->implode(', ');
        $ar = collect($t['reasons'])->map(fn ($r) => $labels[$r][1] ?? null)->filter()->implode('، ');

        return [
            'en' => ucfirst($en ?: 'next in your list').($inPeak ? '; placed in your peak focus hours' : '').($parts > 1 ? "; block {$part} of {$parts}" : '').'.',
            'ar' => ($ar ?: 'التالية في قائمتك').($inPeak ? '؛ في ساعات ذروة تركيزك' : '').($parts > 1 ? "؛ الفترة {$part} من {$parts}" : '').'.',
        ];
    }

    private function duration(int $minutes, bool $ar): string
    {
        $h = intdiv($minutes, 60);
        $m = $minutes % 60;

        return $ar ? trim(($h ? "{$h} س " : '').($m || ! $h ? "{$m} د" : '')) : trim(($h ? "{$h}h " : '').($m || ! $h ? "{$m}m" : ''));
    }
}
