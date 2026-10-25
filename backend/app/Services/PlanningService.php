<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Explainable, deterministic planner. Proposals never touch the calendar until the user accepts them.
 */
class PlanningService
{
    public const MAX_BLOCKS_PER_TASK_PER_DAY = 2;

    public function __construct(private CalendarService $calendar) {}

    private const PRIORITY_BOOST = 60;

    private const REASONS = [
        'urgent' => ['urgent', 'عاجلة'],
        'high' => ['high priority', 'أولوية عالية'],
        'in_progress' => ['already in progress', 'قيد التنفيذ'],
        'overdue' => ['overdue', 'متأخرة'],
        'due_today' => ['due within a day', 'مستحقة خلال يوم'],
        'due_soon' => ['due in the next few days', 'مستحقة خلال أيام'],
        'quick_win' => ['quick win', 'إنجاز سريع'],
        'goal' => ['moves a goal that needs attention', 'تدفع هدفاً يحتاج اهتماماً'],
        'focus_window' => ['placed in your focus hours', 'في ساعات تركيزك'],
        'rescheduled' => ['rescheduled from a missed block', 'أُعيدت جدولتها بعد فترة فائتة'],
        'priority_pick' => ['chosen as a weekly priority', 'مختارة كأولوية أسبوعية'],
        'manual' => ['adjusted by you', 'عدّلتها بنفسك'],
    ];

    /**
     * Planning preferences with defaults.
     *
     * @return array{tz: string, work_start: string, work_end: string, work_days: list<int>, break: int, block: int, focus_start: ?string, focus_end: ?string, daily_limit: ?int}
     */
    public function config(User $user): array
    {
        $prefs = $user->preferences();

        return [
            'tz' => $prefs['timezone'] ?? 'UTC',
            'work_start' => $prefs['work_start'] ?? '09:00',
            'work_end' => $prefs['work_end'] ?? '17:00',
            'work_days' => array_map('intval', $prefs['work_days'] ?? [1, 2, 3, 4, 5]),
            'break' => (int) ($prefs['break_minutes'] ?? 10),
            'block' => (int) ($prefs['focus_block_minutes'] ?? 60),
            'focus_start' => $prefs['focus_start'] ?? null,
            'focus_end' => $prefs['focus_end'] ?? null,
            'daily_limit' => isset($prefs['daily_focus_limit']) ? (int) $prefs['daily_focus_limit'] : null,
            'buffer' => (int) ($prefs['buffer_minutes'] ?? 10),
            'study_start' => $prefs['study_start'] ?? null,
            'study_end' => $prefs['study_end'] ?? null,
            'personal_start' => $prefs['personal_start'] ?? null,
            'personal_end' => $prefs['personal_end'] ?? null,
        ];
    }

    /**
     * Time boundaries for one local day: work (on work days), plus optional study and personal windows.
     *
     * @param  array<string, mixed>  $c
     * @return array<string, array{0: CarbonImmutable, 1: CarbonImmutable}>
     */
    public function windows(array $c, CarbonImmutable $localDay): array
    {
        $day = $localDay->setTimezone($c['tz'])->startOfDay();
        $windows = [];
        if (in_array($day->dayOfWeek, $c['work_days'], true)) {
            $windows['work'] = [$day->setTimeFromTimeString($c['work_start']), $day->setTimeFromTimeString($c['work_end'])];
        }
        foreach (['study', 'personal'] as $area) {
            if (($c["{$area}_start"] ?? null) && ($c["{$area}_end"] ?? null) && $c["{$area}_start"] < $c["{$area}_end"]) {
                $windows[$area] = [$day->setTimeFromTimeString($c["{$area}_start"]), $day->setTimeFromTimeString($c["{$area}_end"])];
            }
        }

        return $windows;
    }

    /**
     * Generate a proposal for $days days starting on $date (user timezone).
     *
     * @param  list<int>  $onlyTaskIds  restrict planning to these tasks (e.g. rescheduling missed work)
     * @param  list<int>  $priorityTaskIds  tasks to plan first (e.g. weekly review priorities)
     */
    public function generate(User $user, string $date, int $days, array $onlyTaskIds = [], array $priorityTaskIds = []): ScheduleProposal
    {
        $plan = $this->compute($user, $date, $days, $onlyTaskIds, $priorityTaskIds);

        return ScheduleProposal::create([
            'user_id' => $user->id,
            'starts_on' => $plan['starts_on'],
            'days' => $days,
            'items' => $plan['items'],
            'warnings' => $plan['warnings'],
            'summary' => $plan['summary'],
        ])->fresh();
    }

    /**
     * The same plan as generate(), without saving anything (used by Copilot, which turns it into an approvable proposal).
     *
     * @param  list<int>  $onlyTaskIds
     * @param  list<int>  $priorityTaskIds
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $reserved  extra busy time (e.g. where proposed moves would go)
     * @return array{starts_on: string, items: list<array<string, mixed>>, warnings: list<array<string, mixed>>, summary: array<string, mixed>}
     */
    public function compute(User $user, string $date, int $days, array $onlyTaskIds = [], array $priorityTaskIds = [], array $reserved = []): array
    {
        $c = $this->config($user);
        $first = CarbonImmutable::parse($date, $c['tz'])->startOfDay();
        $now = CarbonImmutable::now();
        $earliest = $now->addMinutes(5 - $now->minute % 5)->startOfMinute();
        $busy = array_merge($this->calendar->occurrences($user, $first->utc(), $first->addDays($days)->utc())->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all(), $reserved);

        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])
            ->when($onlyTaskIds, fn ($q) => $q->whereIn('id', $onlyTaskIds))
            ->limit(500)->get();
        $futureMinutes = $this->futureScheduledMinutes($user, $open->pluck('id'));
        $missed = $this->missedBlocks($user)->pluck('task_id')->unique()->flip();
        $goalPressure = app(GoalIntelligence::class)->pressure($user);
        $ranked = $open->map(function (Task $task) use ($now, $priorityTaskIds, $goalPressure) {
            $score = BriefingService::score($task, $now->setTimezone('UTC'), $goalPressure);
            if (in_array($task->id, $priorityTaskIds, true)) {
                $score['score'] += self::PRIORITY_BOOST;
                $score['reasons'][] = 'priority_pick';
            }

            return ['task' => $task] + $score;
        })->sort(fn (array $a, array $b) => [$b['score'], $a['task']->due_at?->timestamp ?? PHP_INT_MAX, $a['task']->id] <=> [$a['score'], $b['task']->due_at?->timestamp ?? PHP_INT_MAX, $b['task']->id])->values();

        $dayStates = [];
        for ($d = 0; $d < $days; $d++) {
            $local = $first->addDays($d);
            $dayStates[$d] = [
                'date' => $local->toDateString(),
                'work_day' => in_array($local->dayOfWeek, $c['work_days'], true),
                'start' => $local->setTimeFromTimeString($c['work_start'])->utc(),
                'end' => $local->setTimeFromTimeString($c['work_end'])->utc(),
                'focus' => $c['focus_start'] && $c['focus_end'] ? [$local->setTimeFromTimeString($c['focus_start'])->utc(), $local->setTimeFromTimeString($c['focus_end'])->utc()] : null,
                'planned' => 0,
                'per_task' => [],
            ];
        }

        $items = [];
        $warnings = [];
        foreach ($ranked as $row) {
            /** @var Task $task */
            $task = $row['task'];
            $remaining = max(0, $task->estimated_minutes - $task->actual_minutes - ($futureMinutes[$task->id] ?? 0));
            if ($remaining < 5) {
                continue;
            }
            $blocks = $this->splitIntoBlocks($remaining, $c['block']);
            $trialBusy = $busy;
            $trialDays = $dayStates;
            $taskItems = [];
            foreach ($blocks as $index => $minutes) {
                $slot = $this->findSlot($task, $minutes, $trialDays, $trialBusy, $earliest, $c, in_array($task->priority, ['urgent', 'high'], true));
                if (! $slot) {
                    $taskItems = null;
                    break;
                }
                [$d, $start, $end, $inFocus] = $slot;
                $reasons = $row['reasons'];
                if ($inFocus) {
                    $reasons[] = 'focus_window';
                }
                if ($missed->has($task->id)) {
                    $reasons[] = 'rescheduled';
                }
                $taskItems[] = $this->item($task, $start, $end, $index + 1, count($blocks), $reasons);
                $trialBusy[] = [$start, $end->addMinutes($c['break'])];
                $trialDays[$d]['planned'] += $minutes;
                $trialDays[$d]['per_task'][$task->id] = ($trialDays[$d]['per_task'][$task->id] ?? 0) + 1;
            }
            if ($taskItems === null) {
                $warnings[] = $this->unschedulableWarning($task, $remaining, $days, $first, $items);
            } else {
                $items = array_merge($items, $taskItems);
                $busy = $trialBusy;
                $dayStates = $trialDays;
            }
        }
        usort($items, fn (array $a, array $b) => strcmp($a['starts_at'], $b['starts_at']));

        return ['starts_on' => $first->toDateString(), 'items' => $items, 'warnings' => $warnings, 'summary' => $this->summary($user, $first, $days, $items, $warnings, $c)];
    }

    /**
     * Split work into focus blocks, folding a tiny remainder into the previous block.
     *
     * @return list<int>
     */
    public function splitIntoBlocks(int $minutes, int $blockSize): array
    {
        $blockSize = max(15, $blockSize);
        $blocks = array_fill(0, intdiv($minutes, $blockSize), $blockSize);
        $rest = $minutes % $blockSize;
        if ($rest > 0) {
            if ($blocks && $rest < 15) {
                $blocks[count($blocks) - 1] += $rest;
            } else {
                $blocks[] = $rest;
            }
        }

        return $blocks;
    }

    /**
     * First free slot that respects work hours, deadline, daily limit and per-day spreading.
     *
     * @param  array<int, array<string, mixed>>  $days
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $busy
     * @param  array<string, mixed>  $c
     * @return array{0: int, 1: CarbonImmutable, 2: CarbonImmutable, 3: bool}|null
     */
    private function findSlot(Task $task, int $minutes, array $days, array $busy, CarbonImmutable $earliest, array $c, bool $preferFocus): ?array
    {
        foreach ($days as $d => $day) {
            if (! $day['work_day'] || ($day['per_task'][$task->id] ?? 0) >= self::MAX_BLOCKS_PER_TASK_PER_DAY) {
                continue;
            }
            $limit = $c['daily_limit'] ?? (int) floor($day['start']->diffInMinutes($day['end']) * 0.85);
            if ($limit < $day['planned'] + $minutes) {
                continue;
            }
            $windowStart = max($day['start'], $earliest);
            if ($task->due_at && $windowStart->addMinutes($minutes) > $task->due_at) {
                return null;
            }
            $free = $this->freeIntervals($windowStart, $day['end'], $busy, $c['break']);
            $candidates = $free;
            if ($preferFocus && $day['focus']) {
                $inFocus = [];
                foreach ($free as [$s, $e]) {
                    $fs = max($s, $day['focus'][0]);
                    $fe = min($e, $day['focus'][1]);
                    if ($fe > $fs) {
                        $inFocus[] = [$fs, $fe];
                    }
                }
                $candidates = array_merge($inFocus, $free);
            }
            foreach ($candidates as [$s, $e]) {
                $end = $s->addMinutes($minutes);
                if ($end > $e || ($task->due_at && $end > $task->due_at)) {
                    continue;
                }
                $focus = $day['focus'] && $s >= $day['focus'][0] && $end <= $day['focus'][1];

                return [$d, $s, $end, $focus];
            }
        }

        return null;
    }

    /**
     * Free intervals inside [start, end) after removing busy time and a trailing break after each busy block.
     *
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $busy
     * @return list<array{0: CarbonImmutable, 1: CarbonImmutable}>
     */
    public function freeIntervals(CarbonImmutable $start, CarbonImmutable $end, array $busy, int $break = 0): array
    {
        if ($end <= $start) {
            return [];
        }
        $relevant = collect($busy)
            ->map(fn (array $b) => [CarbonImmutable::parse($b[0]), CarbonImmutable::parse($b[1])->addMinutes($break)])
            ->filter(fn (array $b) => $b[0] < $end && $b[1] > $start)
            ->sortBy(fn (array $b) => $b[0]->getTimestamp())
            ->values();
        $free = [];
        $cursor = $start;
        foreach ($relevant as [$s, $e]) {
            if ($s > $cursor) {
                $free[] = [$cursor, min($s, $end)];
            }
            $cursor = max($cursor, $e);
            if ($cursor >= $end) {
                break;
            }
        }
        if ($cursor < $end) {
            $free[] = [$cursor, $end];
        }

        return array_values(array_filter($free, fn (array $f) => $f[0]->diffInMinutes($f[1]) >= 5));
    }

    /**
     * @param  list<string>  $reasons
     * @return array<string, mixed>
     */
    private function item(Task $task, CarbonImmutable $start, CarbonImmutable $end, int $part, int $parts, array $reasons, bool $manual = false): array
    {
        $reasons = array_values(array_unique($reasons));

        return [
            'key' => $task->id.'-'.$part.'-'.$start->getTimestamp(),
            'task_id' => $task->id,
            'task_version' => $task->updated_at->toISOString(),
            'title' => $task->title,
            'priority' => $task->priority,
            'starts_at' => $start->utc()->toIso8601String(),
            'ends_at' => $end->utc()->toIso8601String(),
            'minutes' => (int) $start->diffInMinutes($end),
            'part' => $part,
            'parts' => $parts,
            'manual' => $manual,
            'reasons' => $reasons,
            'explanation' => $this->explain($task, $reasons, $part, $parts),
        ];
    }

    /**
     * @param  list<string>  $reasons
     * @return array{en: string, ar: string}
     */
    private function explain(Task $task, array $reasons, int $part, int $parts): array
    {
        $priority = ['urgent' => ['Urgent', 'عاجلة'], 'high' => ['High priority', 'أولوية عالية'], 'medium' => ['Medium priority', 'أولوية متوسطة'], 'low' => ['Low priority', 'أولوية منخفضة']][$task->priority] ?? ['Task', 'مهمة'];
        $en = [$priority[0]];
        $ar = [$priority[1]];
        foreach ($reasons as $reason) {
            if (isset(self::REASONS[$reason]) && ! in_array($reason, ['urgent', 'high'], true)) {
                $en[] = self::REASONS[$reason][0];
                $ar[] = self::REASONS[$reason][1];
            }
        }
        if ($parts > 1) {
            $en[] = "focus block {$part} of {$parts}";
            $ar[] = "فترة تركيز {$part} من {$parts}";
        }
        if ($task->due_at) {
            $en[] = 'finishes before the deadline';
            $ar[] = 'تنتهي قبل الموعد النهائي';
        }

        return ['en' => implode(' · ', $en), 'ar' => implode(' · ', $ar)];
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @return array<string, mixed>
     */
    private function unschedulableWarning(Task $task, int $remaining, int $days, CarbonImmutable $first, array $items): array
    {
        $alternatives = [];
        $deadlineInside = $task->due_at && $task->due_at < $first->addDays($days);
        if ($deadlineInside) {
            $alternatives[] = ['type' => 'deadline', 'en' => 'Move the deadline or ask for more time.', 'ar' => 'انقل الموعد النهائي أو اطلب وقتاً إضافياً.'];
            $alternatives[] = ['type' => 'scope', 'en' => 'Reduce the scope or the estimate, then plan again.', 'ar' => 'قلّل النطاق أو المدة المقدّرة ثم خطّط مجدداً.'];
        } elseif ($days < 7) {
            $alternatives[] = ['type' => 'horizon', 'en' => 'Plan a full week to find enough time.', 'ar' => 'خطّط لأسبوع كامل لإيجاد وقت كافٍ.'];
        } else {
            $alternatives[] = ['type' => 'next_week', 'en' => 'Carry it over to next week’s plan.', 'ar' => 'انقلها إلى خطة الأسبوع القادم.'];
        }
        $lower = collect($items)->filter(fn (array $i) => (BriefingService::PRIORITY_WEIGHTS[$i['priority']] ?? 0) < (BriefingService::PRIORITY_WEIGHTS[$task->priority] ?? 0))->first();
        if ($lower) {
            $alternatives[] = ['type' => 'swap', 'task_id' => $lower['task_id'], 'en' => "Remove a block of “{$lower['title']}” to make room.", 'ar' => "احذف فترة من «{$lower['title']}» لإفساح المجال."];
        }
        $alternatives[] = ['type' => 'manual', 'en' => 'Add a block manually, even outside working hours.', 'ar' => 'أضف فترة يدوياً، حتى خارج ساعات العمل.'];

        return [
            'task_id' => $task->id,
            'title' => $task->title,
            'priority' => $task->priority,
            'needed_minutes' => $remaining,
            'due_at' => $task->due_at?->toIso8601String(),
            'reason' => $deadlineInside ? 'Insufficient time before the deadline. No partial task was scheduled.' : 'Not enough free working time in this window. No partial task was scheduled.',
            'reason_ar' => $deadlineInside ? 'لا يوجد وقت كافٍ قبل الموعد النهائي. لم تتم جدولة المهمة جزئياً.' : 'لا يوجد وقت عمل كافٍ في هذه الفترة. لم تتم جدولة المهمة جزئياً.',
            'alternatives' => $alternatives,
        ];
    }

    /**
     * Per-day capacity, load and overload detection for a proposal.
     *
     * @param  list<array<string, mixed>>  $items
     * @param  list<array<string, mixed>>  $warnings
     * @param  array<string, mixed>|null  $c
     * @return array<string, mixed>
     */
    public function summary(User $user, CarbonImmutable $first, int $days, array $items, array $warnings, ?array $c = null, ?Collection $events = null): array
    {
        $c ??= $this->config($user);
        $first = $first->setTimezone($c['tz'])->startOfDay();
        // Callers that already filtered the calendar (e.g. by allowed data sources) pass their occurrences.
        $events ??= $this->calendar->occurrences($user, $first->utc(), $first->addDays($days)->utc());
        $overlap = function (CarbonImmutable $s, CarbonImmutable $e, CarbonImmutable $ws, CarbonImmutable $we): int {
            $a = max($s, $ws);
            $b = min($e, $we);

            return $b > $a ? (int) $a->diffInMinutes($b) : 0;
        };
        $result = [];
        for ($d = 0; $d < $days; $d++) {
            $local = $first->addDays($d);
            $workDay = in_array($local->dayOfWeek, $c['work_days'], true);
            $ws = $local->setTimeFromTimeString($c['work_start']);
            $we = $local->setTimeFromTimeString($c['work_end']);
            $capacity = $workDay ? (int) $ws->diffInMinutes($we) : 0;
            $fixed = (int) $events->where('kind', 'fixed')->sum(fn (array $e) => $overlap($e['starts_at'], $e['ends_at'], $ws, $we));
            $flexible = (int) $events->where('kind', '!=', 'fixed')->sum(fn (array $e) => $overlap($e['starts_at'], $e['ends_at'], $ws, $we));
            $planned = (int) collect($items)->sum(fn (array $i) => $overlap(CarbonImmutable::parse($i['starts_at']), CarbonImmutable::parse($i['ends_at']), $local, $local->addDay()));
            $load = $capacity ? (int) round(($fixed + $flexible + $planned) / $capacity * 100) : ($planned ? 100 : 0);
            $result[] = [
                'date' => $local->toDateString(),
                'work_day' => $workDay,
                'capacity_minutes' => $capacity,
                'fixed_minutes' => $fixed,
                'existing_flexible_minutes' => $flexible,
                'planned_minutes' => $planned,
                'free_minutes' => max(0, $capacity - $fixed - $flexible - $planned),
                'load_percent' => $load,
                'overloaded' => $load >= 90,
            ];
        }
        $lightest = collect($result)->where('work_day', true)->sortBy('load_percent')->first();
        $overloaded = collect($result)->where('overloaded', true)->values();

        return [
            'days' => $result,
            'totals' => [
                'planned_minutes' => (int) collect($items)->sum('minutes'),
                'blocks' => count($items),
                'tasks_scheduled' => collect($items)->pluck('task_id')->unique()->count(),
                'tasks_unscheduled' => count($warnings),
                'unscheduled_minutes' => (int) collect($warnings)->sum('needed_minutes'),
                'capacity_minutes' => (int) collect($result)->sum('capacity_minutes'),
            ],
            'overload' => $overloaded->map(fn (array $day) => [
                'date' => $day['date'],
                'load_percent' => $day['load_percent'],
                'en' => $lightest && $lightest['date'] !== $day['date'] ? "{$day['date']} is {$day['load_percent']}% booked. Consider moving a flexible block to {$lightest['date']} ({$lightest['load_percent']}%)." : "{$day['date']} is {$day['load_percent']}% booked. Consider dropping or shortening a flexible block.",
                'ar' => $lightest && $lightest['date'] !== $day['date'] ? "يوم {$day['date']} محجوز بنسبة {$day['load_percent']}٪. فكّر في نقل فترة مرنة إلى {$lightest['date']} ({$lightest['load_percent']}٪)." : "يوم {$day['date']} محجوز بنسبة {$day['load_percent']}٪. فكّر في حذف فترة مرنة أو تقصيرها.",
                'suggested_date' => $lightest && $lightest['date'] !== $day['date'] ? $lightest['date'] : null,
            ])->all(),
        ];
    }

    /**
     * Replace a pending proposal's items with the user's edited version.
     *
     * @param  list<array{key?: string|null, task_id: int, starts_at: string, ends_at: string}>  $edited
     */
    public function update(User $user, int $id, array $edited): ScheduleProposal
    {
        return DB::transaction(function () use ($user, $id, $edited) {
            $proposal = ScheduleProposal::where('user_id', $user->id)->lockForUpdate()->findOrFail($id);
            if ($proposal->status !== 'pending') {
                throw ValidationException::withMessages(['proposal' => ['This proposal has already been resolved.']]);
            }
            $original = collect($proposal->items)->keyBy('key');
            $tasks = Task::where('user_id', $user->id)->whereIn('id', collect($edited)->pluck('task_id'))->get()->keyBy('id');
            $items = [];
            $errors = [];
            foreach (array_values($edited) as $index => $row) {
                $task = $tasks->get($row['task_id']);
                $start = CarbonImmutable::parse($row['starts_at'])->utc();
                $end = CarbonImmutable::parse($row['ends_at'])->utc();
                if (! $task) {
                    $errors["items.$index.task_id"] = ['This task is not available.'];

                    continue;
                }
                if ($start->isPast()) {
                    $errors["items.$index.starts_at"] = ['A block cannot start in the past.'];
                }
                $conflict = $this->calendar->conflicts($user, $start, $end)->first();
                if ($conflict) {
                    $errors["items.$index.starts_at"] = ["Conflicts with “{$conflict['title']}”."];
                }
                foreach ($items as $other) {
                    if ($start < CarbonImmutable::parse($other['ends_at']) && $end > CarbonImmutable::parse($other['starts_at'])) {
                        $errors["items.$index.starts_at"] = ["Overlaps “{$other['title']}” in this plan."];
                    }
                }
                $before = isset($row['key']) ? $original->get($row['key']) : null;
                $unchanged = $before && $before['task_id'] === $task->id && $before['starts_at'] === $start->toIso8601String() && $before['ends_at'] === $end->toIso8601String();
                if ($unchanged) {
                    $items[] = $before;

                    continue;
                }
                $reasons = array_values(array_diff($before['reasons'] ?? [], ['focus_window']));
                $reasons[] = 'manual';
                $item = $this->item($task, $start, $end, $before['part'] ?? 1, $before['parts'] ?? 1, $reasons, true);
                if ($before) {
                    $item['task_version'] = $before['task_version'];
                }
                $items[] = $item;
            }
            if ($errors) {
                throw ValidationException::withMessages($errors);
            }
            usort($items, fn (array $a, array $b) => strcmp($a['starts_at'], $b['starts_at']));
            $c = $this->config($user);
            $first = CarbonImmutable::parse($proposal->starts_on ?? now($c['tz'])->toDateString(), $c['tz']);
            $proposal->update(['items' => $items, 'summary' => $this->summary($user, $first, $proposal->days ?: 1, $items, $proposal->warnings, $c)]);

            return $proposal->fresh();
        });
    }

    public function accept(User $user, int $id): ScheduleProposal
    {
        return DB::transaction(function () use ($user, $id) {
            User::whereKey($user->id)->lockForUpdate()->firstOrFail();
            $proposal = ScheduleProposal::where('user_id', $user->id)->lockForUpdate()->findOrFail($id);
            if ($proposal->status !== 'pending') {
                throw ValidationException::withMessages(['proposal' => ['This proposal has already been resolved.']]);
            }
            $c = $this->config($user);
            $tasks = Task::where('user_id', $user->id)->whereIn('id', collect($proposal->items)->pluck('task_id'))->get()->keyBy('id');
            $starts = collect($proposal->items)->map(fn (array $i) => CarbonImmutable::parse($i['starts_at']));
            $ends = collect($proposal->items)->map(fn (array $i) => CarbonImmutable::parse($i['ends_at']));
            $occupied = $starts->isEmpty() ? collect() : $this->calendar->occurrences($user, $starts->min()->utc(), $ends->max()->utc())->map(fn (array $o) => [$o['starts_at'], $o['ends_at']]);
            $future = $this->futureScheduledMinutes($user, $tasks->keys());
            foreach (collect($proposal->items)->groupBy('task_id') as $taskId => $parts) {
                $task = $tasks->get($taskId);
                if (! $task || in_array($task->status, ['completed', 'cancelled'])) {
                    throw ValidationException::withMessages(['proposal' => ['Tasks or dates changed. Generate a fresh proposal.']]);
                }
                $autoPlanned = $parts->where('manual', false)->sum(fn (array $part) => CarbonImmutable::parse($part['starts_at'])->diffInMinutes(CarbonImmutable::parse($part['ends_at'])));
                $remaining = max(0, $task->estimated_minutes - $task->actual_minutes - ($future[$task->id] ?? 0));
                // Day plans may stretch an estimate by the user's measured accuracy (capped at 1.5x).
                $remaining *= min(1.5, max(1.0, (float) $parts->max(fn (array $part) => $part['estimate_factor'] ?? 1.0)));
                $stale = $parts->contains(fn (array $part) => isset($part['task_version']) && $part['task_version'] !== $task->updated_at->toISOString());
                if ($stale || $autoPlanned > $remaining + 0.01) {
                    throw ValidationException::withMessages(['proposal' => ['A task changed after this proposal. Generate a fresh plan.']]);
                }
            }
            foreach ($proposal->items as $item) {
                $task = $tasks->get($item['task_id']);
                $start = CarbonImmutable::parse($item['starts_at']);
                $end = CarbonImmutable::parse($item['ends_at']);
                $manual = (bool) ($item['manual'] ?? false);
                $localStart = $start->setTimezone($c['tz']);
                $localEnd = $end->setTimezone($c['tz']);
                $window = $this->windows($c, $localStart)[$item['area'] ?? 'work'] ?? null;
                $outsideHours = ! $window || $localStart->toDateString() !== $localEnd->toDateString() || $localStart < $window[0] || $localEnd > $window[1];
                if ($end <= $start || (! $manual && $outsideHours)) {
                    throw ValidationException::withMessages(['proposal' => ['Availability changed. Generate a fresh proposal.']]);
                }
                if ($start->isPast() || (! $manual && $task->due_at && $end > $task->due_at)) {
                    throw ValidationException::withMessages(['proposal' => ['Tasks or dates changed. Generate a fresh proposal.']]);
                }
                foreach ($occupied as [$busyStart, $busyEnd]) {
                    if ($start < $busyEnd && $end > $busyStart) {
                        throw ValidationException::withMessages(['proposal' => ['The calendar changed. Generate a new plan to avoid conflicts.']]);
                    }
                }
                $event = CalendarEvent::create(['user_id' => $user->id, 'task_id' => $task->id, 'title' => $task->title, 'starts_at' => $start->utc(), 'ends_at' => $end->utc(), 'kind' => 'flexible']);
                $occupied->push([$event->starts_at, $event->ends_at]);
                $task->forceFill(['scheduled_start' => $task->scheduled_start && $task->scheduled_start < $start ? $task->scheduled_start : $start, 'scheduled_end' => $task->scheduled_end && $task->scheduled_end > $end ? $task->scheduled_end : $end])->saveQuietly();
            }
            $proposal->update(['status' => 'accepted', 'accepted_at' => now()]);

            return $proposal;
        });
    }

    /**
     * Minutes of each task already scheduled from now on.
     *
     * @param  iterable<int>  $taskIds
     * @return array<int, int>
     */
    private function futureScheduledMinutes(User $user, iterable $taskIds): array
    {
        $now = CarbonImmutable::now();
        $minutes = [];
        foreach (CalendarEvent::where('user_id', $user->id)->whereNull('recurrence')->whereIn('task_id', collect($taskIds))->where('ends_at', '>', $now)->get() as $event) {
            $minutes[$event->task_id] = ($minutes[$event->task_id] ?? 0) + (int) max($event->starts_at, $now)->diffInMinutes($event->ends_at);
        }

        return $minutes;
    }

    /**
     * Past flexible task blocks (last 14 days) whose task is still open and had no focus time logged on that day.
     *
     * @return Collection<int, array{event_id: int, task_id: int, title: string, starts_at: string, ends_at: string, minutes: int}>
     */
    public function missedBlocks(User $user): Collection
    {
        $tz = $user->timezone();
        $events = CalendarEvent::where('user_id', $user->id)->whereNull('recurrence')->where('kind', 'flexible')->whereNotNull('task_id')
            ->where('ends_at', '<', now())->where('ends_at', '>=', now()->subDays(14))->orderBy('starts_at')->get();
        if ($events->isEmpty()) {
            return collect();
        }
        $openTasks = Task::where('user_id', $user->id)->whereIn('id', $events->pluck('task_id'))->whereNotIn('status', ['completed', 'cancelled'])->pluck('id')->flip();
        $sessions = FocusSession::where('user_id', $user->id)->whereIn('task_id', $events->pluck('task_id'))->where('status', 'completed')->where('completed_at', '>=', now()->subDays(15))->get();

        return $events->filter(function (CalendarEvent $event) use ($openTasks, $sessions, $tz) {
            if (! $openTasks->has($event->task_id)) {
                return false;
            }
            $day = $event->starts_at->setTimezone($tz)->toDateString();

            return ! $sessions->contains(fn (FocusSession $s) => $s->task_id === $event->task_id && $s->completed_at->setTimezone($tz)->toDateString() === $day);
        })->map(fn (CalendarEvent $event) => ['event_id' => $event->id, 'task_id' => $event->task_id, 'title' => $event->title, 'starts_at' => $event->starts_at->toIso8601String(), 'ends_at' => $event->ends_at->toIso8601String(), 'minutes' => (int) $event->starts_at->diffInMinutes($event->ends_at)])->values();
    }

    /**
     * Planned (flexible task blocks) versus actual (focus time on tasks) for a date range.
     *
     * @return array<string, mixed>
     */
    public function plannedVsActual(User $user, CarbonImmutable $from, int $days): array
    {
        $tz = $user->timezone();
        $from = $from->setTimezone($tz)->startOfDay();
        $to = $from->addDays($days);
        $blocks = CalendarEvent::where('user_id', $user->id)->whereNull('recurrence')->where('kind', 'flexible')->whereNotNull('task_id')->where('starts_at', '>=', $from->utc())->where('starts_at', '<', $to->utc())->get();
        $sessions = FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')->whereBetween('completed_at', [$from->utc(), $to->utc()])->get();
        $taskIds = $blocks->pluck('task_id')->unique();
        $tasks = Task::where('user_id', $user->id)->whereIn('id', $taskIds)->get()->keyBy('id');
        $series = [];
        for ($d = 0; $d < $days; $d++) {
            $date = $from->addDays($d)->toDateString();
            $series[$date] = ['date' => $date, 'planned_minutes' => 0, 'actual_minutes' => 0];
        }
        foreach ($blocks as $block) {
            $series[$block->starts_at->setTimezone($tz)->toDateString()]['planned_minutes'] += (int) $block->starts_at->diffInMinutes($block->ends_at);
        }
        $actualByTask = [];
        foreach ($sessions as $session) {
            $key = $session->completed_at->setTimezone($tz)->toDateString();
            if (isset($series[$key]) && $session->task_id && $taskIds->contains($session->task_id)) {
                $series[$key]['actual_minutes'] += (int) floor($session->elapsed_seconds / 60);
            }
            if ($session->task_id) {
                $actualByTask[$session->task_id] = ($actualByTask[$session->task_id] ?? 0) + (int) floor($session->elapsed_seconds / 60);
            }
        }
        $perTask = $taskIds->map(function (int $id) use ($tasks, $blocks, $actualByTask) {
            $task = $tasks->get($id);

            return ['task_id' => $id, 'title' => $task?->title ?? '—', 'status' => $task?->status, 'planned_minutes' => (int) $blocks->where('task_id', $id)->sum(fn (CalendarEvent $b) => $b->starts_at->diffInMinutes($b->ends_at)), 'actual_minutes' => $actualByTask[$id] ?? 0];
        })->sortByDesc('planned_minutes')->values();
        $planned = (int) collect($series)->sum('planned_minutes');
        $actual = (int) collect($series)->sum('actual_minutes');
        $completedPlanned = $perTask->where('status', 'completed')->count();

        return [
            'from' => $from->toDateString(),
            'days' => array_values($series),
            'tasks' => $perTask->all(),
            'totals' => [
                'planned_minutes' => $planned,
                'actual_minutes' => $actual,
                'ratio' => $planned ? round($actual / $planned, 2) : null,
                'planned_tasks' => $perTask->count(),
                'completed_planned_tasks' => $completedPlanned,
                'completion_rate' => $perTask->count() ? (int) round($completedPlanned / $perTask->count() * 100) : null,
            ],
        ];
    }
}
