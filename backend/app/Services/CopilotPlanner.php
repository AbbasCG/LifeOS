<?php

namespace App\Services;

use App\Models\Category;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;

/**
 * Multi-step planning for Copilot conversations. It reuses the existing planners (PlanningService for weeks, DayPlanner
 * for a day after an interruption, free-time search around every commitment) and returns:
 *
 * - a structured plan: explanation, conflicts, alternatives and expected impact;
 * - a pending proposal of new LifeOS blocks (AssistantActions): previewed, partially approvable, re-validated at apply
 *   time and undoable. Existing events — fixed appointments above all — are never moved, and nothing is written to
 *   connected calendars;
 * - or a clarification question when the request is genuinely ambiguous.
 */
class CopilotPlanner
{
    public const MAX_BLOCKS = 30;

    public const PRIORITIES = ['study', 'work', 'personal', 'projects', 'deadlines'];

    public function __construct(private PlanningService $planning, private DayPlanner $day, private CalendarService $calendar, private AssistantActions $actions) {}

    public const INTENTS = ['plan_week', 'prioritize', 'focus_blocks', 'reorganize_day'];

    private const COUNTS = ['one' => 1, 'two' => 2, 'three' => 3, 'four' => 4, 'five' => 5, 'six' => 6, 'a couple of' => 2, 'couple of' => 2,
        'واحدة' => 1, 'فترتين' => 2, 'فترتي' => 2, 'اثنتين' => 2, 'ثلاث' => 3, 'أربع' => 4, 'اربع' => 4, 'خمس' => 5, 'ست' => 6];

    /**
     * Run a planning intent with its slots (from the local parser, the provider, a clarification answer or a follow-up).
     *
     * @param  array<string, mixed>  $slots
     * @return array<string, mixed>
     */
    public function run(User $user, string $intent, array $slots, bool $ar, string $provider): array
    {
        $priorities = array_values(array_intersect(self::PRIORITIES, (array) ($slots['priorities'] ?? [])));
        $alternative = is_string($slots['alternative'] ?? null) ? $slots['alternative'] : null;
        $tz = $user->timezone();

        return match ($intent) {
            'plan_week' => $this->planWeek($user, $ar, $provider, $priorities, in_array($alternative, ['balanced', 'essentials'], true) ? $alternative : 'balanced', (bool) ($slots['next_week'] ?? false)),
            'prioritize' => $this->prioritize($user, $ar, $provider, $priorities, (bool) ($slots['next_week'] ?? false), in_array($alternative, ['balanced', 'essentials'], true) ? $alternative : 'balanced'),
            'focus_blocks' => $this->focusBlocks($user, $ar, $provider, (int) ($slots['count'] ?? 3), isset($slots['minutes']) ? (int) $slots['minutes'] : null,
                in_array($slots['within'] ?? null, ['today', 'tomorrow', 'week'], true) ? $slots['within'] : 'week', in_array($alternative, ['short', 'default', 'long'], true) ? $alternative : 'default'),
            'reorganize_day' => $this->reorganizeDay($user, $ar, $provider, $this->date($slots['date'] ?? null, $tz),
                array_filter(['busy_until' => $slots['interruption']['busy_until'] ?? null, 'lost_minutes' => $slots['interruption']['lost_minutes'] ?? null]),
                (bool) ($slots['ask_interruption'] ?? false), in_array($alternative, DayPlanner::VARIANTS, true) ? $alternative : null),
        };
    }

    /**
     * Deterministic slot extraction for the local assistant.
     *
     * @return array<string, mixed>
     */
    public static function slotsFrom(string $intent, string $message, CarbonImmutable $now): array
    {
        $text = mb_strtolower(strtr($message, ['٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9']));
        $nextWeek = (bool) preg_match('/next week|coming week|الأسبوع القادم|الاسبوع القادم|الأسبوع المقبل|الاسبوع المقبل/u', $text);
        $tomorrow = (bool) preg_match('/tomorrow|غدا|غداً|الغد|بكرة|بكره/u', $text);

        return match ($intent) {
            'plan_week', 'prioritize' => ['priorities' => self::prioritiesIn($text), 'next_week' => $nextWeek, 'alternative' => preg_match('/essential|only the important|الأساسي|الضروري/u', $text) ? 'essentials' : 'balanced'],
            'focus_blocks' => array_filter([
                'count' => self::countIn($text),
                'minutes' => self::minutesIn($text),
                'within' => $tomorrow ? 'tomorrow' : (preg_match('/\btoday\b|اليوم/u', $text) ? 'today' : 'week'),
            ], fn ($v) => $v !== null),
            'reorganize_day' => [
                'date' => ($tomorrow ? $now->addDay() : $now)->toDateString(),
                'interruption' => array_filter(['busy_until' => self::untilIn($text), 'lost_minutes' => preg_match('/lost|lose|wasted|ضاع|خسرت|فقدت/u', $text) ? self::minutesIn($text) : null]),
                'ask_interruption' => (bool) preg_match('/interrupt|disrupt|derail|emergenc|مقاطع|انقطاع|طارئ/u', $text),
            ],
            default => [],
        };
    }

    public static function countIn(string $text): ?int
    {
        if (preg_match('/(\d+)\s*(?:focus|deep|blocks?|sessions?|slots?|فترات|فترة|جلسات)/u', $text, $m)) {
            return max(1, min(6, (int) $m[1]));
        }
        foreach (self::COUNTS as $word => $n) {
            if (preg_match('/(?<!\pL)'.preg_quote($word, '/').'(?!\pL)/u', $text)) {
                return $n;
            }
        }

        return null;
    }

    public static function minutesIn(string $text): ?int
    {
        if (preg_match('/(\d+(?:[.,]\d+)?)\s*-?\s*(hours?|hrs?|h\b|ساعات|ساعة|minutes?|mins?|min\b|دقيقة|دقائق)/u', $text, $m)) {
            $value = (float) str_replace(',', '.', $m[1]);

            return (int) round(preg_match('/^(h|hr|hour|ساع)/u', $m[2]) ? $value * 60 : $value);
        }

        return match (true) {
            (bool) preg_match('/two hours|ساعتين|ساعتان/u', $text) => 120,
            (bool) preg_match('/half an hour|نصف ساعة/u', $text) => 30,
            (bool) preg_match('/an hour|one hour|ساعة واحدة|ساعة/u', $text) => 60,
            default => null,
        };
    }

    public static function untilIn(string $text): ?string
    {
        if (preg_match('/(?:until|till|til|حتى|لغاية)\s+(?:the\s+|الساعة\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|ص|م)?/u', $text, $m)) {
            $hour = (int) $m[1];
            if (in_array($m[3] ?? '', ['pm', 'م'], true) && $hour < 12) {
                $hour += 12;
            } elseif (($m[3] ?? '') === '' && $hour >= 1 && $hour <= 7) {
                $hour += 12;
            }

            return $hour <= 23 ? sprintf('%02d:%02d', $hour, (int) ($m[2] ?? 0)) : null;
        }

        return null;
    }

    private function date(mixed $value, string $tz): string
    {
        $today = CarbonImmutable::now($tz)->startOfDay();
        if (is_string($value) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
            $date = CarbonImmutable::parse($value, $tz);
            if ($date >= $today && $date <= $today->addDays(14)) {
                return $date->toDateString();
            }
        }

        return $today->toDateString();
    }

    /**
     * Plan the coming week (or next week) around every commitment, optionally putting chosen priorities first.
     *
     * @param  list<string>  $priorities
     * @return array<string, mixed>
     */
    public function planWeek(User $user, bool $ar, string $provider, array $priorities = [], string $alternative = 'balanced', bool $nextWeek = false, string $kind = 'plan_week'): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $start = $nextWeek ? $now->startOfDay()->next(CarbonImmutable::MONDAY) : $now->startOfDay();
        $priorityIds = $this->taskIdsFor($user, $priorities, $start, 7);
        $only = $alternative === 'essentials' ? $this->essentialIds($user, $start, 7, $priorityIds) : [];
        $plan = $this->planning->compute($user, $start->toDateString(), 7, $only, $priorityIds);
        $items = array_slice($plan['items'], 0, self::MAX_BLOCKS);
        $commitments = $this->calendar->occurrences($user, $start->utc(), $start->addDays(7)->utc());
        $fixed = $commitments->where('kind', 'fixed')->count();
        $labels = $this->priorityLabels($priorities, $ar);
        $range = $this->range($start, $start->addDays(6), $ar);

        $explanation = [
            $ar ? "خطة {$range} حول ".$commitments->count()." التزاماً ({$fixed} ثابتاً). لا يُنقل أي موعد قائم؛ الفترات الجديدة تستخدم الوقت المتاح فقط." : "Plan for {$range} around ".$commitments->count()." commitment(s) ({$fixed} fixed). No existing event moves; new blocks only use free time.",
            $ar ? 'الفترات ضمن ساعات عملك مع استراحات، والأعمال الكبيرة مقسّمة إلى فترات تركيز.' : 'Blocks stay inside your working hours with breaks; large work is split into focus-sized blocks.',
        ];
        if ($labels) {
            $explanation[] = $ar ? 'خُطّطت أولوياتك أولاً: '.implode('، ', $labels).'.' : 'Your priorities were planned first: '.implode(', ', $labels).'.';
        }
        if ($alternative === 'essentials') {
            $explanation[] = $ar ? 'نسخة الأساسيات: العاجل والمهم وما يستحق هذا الأسبوع فقط.' : 'Essentials version: only urgent, high-priority and due-this-week work.';
        }
        if (count($plan['items']) > self::MAX_BLOCKS) {
            $explanation[] = $ar ? 'عُرضت أول '.self::MAX_BLOCKS.' فترة؛ اطلب الخطة مجدداً بعد تطبيقها للبقية.' : 'Showing the first '.self::MAX_BLOCKS.' blocks; ask again after applying them for the rest.';
        }
        $blocks = array_map(fn (array $i) => ['title' => $i['title'], 'task_id' => $i['task_id'], 'starts_at' => CarbonImmutable::parse($i['starts_at']), 'ends_at' => CarbonImmutable::parse($i['ends_at'])], $items);
        $summary = $blocks === []
            ? ($ar ? "لم يتسع {$range} لفترات جديدة حول التزاماتك." : "{$range} has no room for new blocks around your commitments.")
            : ($ar ? 'اقتراح '.count($blocks)." فترة لـ{$range}. راجعها واختر ما تضيفه." : 'Suggested '.count($blocks)." block(s) for {$range}. Review them and choose what to add.");
        $proposal = $blocks ? $this->actions->proposeBlocks($user, $kind, $provider, $summary, $explanation, $blocks) : null;
        $days = collect($plan['summary']['days']);
        $busiest = $days->sortByDesc('load_percent')->first();

        return [
            'message' => $summary,
            'proposal' => $proposal?->present(),
            'plan' => [
                'kind' => $kind, 'title' => $ar ? "خطة {$range}" : "Plan for {$range}", 'explanation' => $explanation,
                'conflicts' => array_merge(
                    array_map(fn (array $w) => ['type' => 'unscheduled', 'title' => $w['title'], 'detail' => $ar ? ($w['reason_ar'] ?? '') : $w['reason'], 'minutes' => $w['needed_minutes']], $plan['warnings']),
                    array_map(fn (array $o) => ['type' => 'overloaded', 'title' => $o['date'], 'detail' => $ar ? $o['ar'] : $o['en'], 'minutes' => null], $plan['summary']['overload']),
                ),
                'alternatives' => [
                    ['key' => 'balanced', 'label' => $ar ? 'كل الأعمال حسب الأولوية' : 'Everything, by priority', 'current' => $alternative === 'balanced'],
                    ['key' => 'essentials', 'label' => $ar ? 'الأساسيات فقط' : 'Essentials only', 'current' => $alternative === 'essentials'],
                ],
                'impact' => ['blocks' => count($blocks), 'planned_minutes' => (int) array_sum(array_column($items, 'minutes')), 'tasks_scheduled' => count(array_unique(array_column($items, 'task_id'))),
                    'tasks_unscheduled' => count($plan['warnings']), 'busiest_day' => $busiest ? ['date' => $busiest['date'], 'load_percent' => $busiest['load_percent']] : null],
            ],
            'state' => ['intent' => $kind, 'slots' => ['priorities' => $priorities, 'alternative' => $alternative, 'next_week' => $nextWeek]],
        ];
    }

    /**
     * @param  list<string>  $priorities
     * @return array<string, mixed>
     */
    public function prioritize(User $user, bool $ar, string $provider, array $priorities, bool $nextWeek = false, string $alternative = 'balanced'): array
    {
        if ($priorities === []) {
            return $this->clarify($ar, 'prioritize', 'priorities',
                $ar ? 'ما الذي يجب أن يأتي أولاً؟' : 'What should come first?',
                collect(self::PRIORITIES)->map(fn ($p) => ['value' => $p, 'label' => ['en' => ucfirst($this->priorityLabels([$p], false)[0]), 'ar' => $this->priorityLabels([$p], true)[0]]])->all());
        }

        return $this->planWeek($user, $ar, $provider, $priorities, $alternative, $nextWeek, 'prioritize');
    }

    /**
     * Find focus blocks in free time only (fixed appointments and every other event stay where they are).
     *
     * @return array<string, mixed>
     */
    public function focusBlocks(User $user, bool $ar, string $provider, int $count = 3, ?int $minutes = null, string $within = 'week', string $alternative = 'default'): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $count = max(1, min(6, $count));
        $minutes = match ($alternative) {
            'short' => 45, 'long' => 90, default => max(30, min(180, $minutes ?? max(60, (int) $c['block'])))
        };
        $first = $within === 'tomorrow' ? $now->startOfDay()->addDay() : $now->startOfDay();
        $days = $within === 'week' ? 7 : 1;
        $occurrences = $this->calendar->occurrences($user, $first->utc(), $first->addDays($days)->utc());
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at']->subMinutes($c['break']), $o['ends_at']->addMinutes($c['break'])])->all();
        $earliest = $now->addMinutes(15 - $now->minute % 15)->startOfMinute();
        $tasks = BriefingService::rank(Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(200)->get(), $now)->pluck('task')->values();
        $blocks = [];
        // First pass: at most one block per day, preferring the focus window; second pass fills remaining days.
        foreach ([1, 2] as $perDay) {
            for ($d = 0; $d < $days && count($blocks) < $count; $d++) {
                $day = $first->addDays($d);
                if ($perDay === 1 && collect($blocks)->contains(fn ($b) => $b['starts_at']->setTimezone($c['tz'])->isSameDay($day))) {
                    continue;
                }
                $windows = $this->planning->windows($c, $day);
                $window = $windows['work'] ?? null;
                if (! $window) {
                    continue;
                }
                $preferred = $c['focus_start'] && $c['focus_end'] ? [$day->setTimeFromTimeString($c['focus_start']), $day->setTimeFromTimeString($c['focus_end'])] : null;
                foreach (array_filter([$preferred, $window]) as [$from, $to]) {
                    $from = max($from, $earliest);
                    if ($from >= $to) {
                        continue;
                    }
                    $free = collect($this->planning->freeIntervals($from->utc(), $to->utc(), $busy))->first(fn ($f) => $f[0]->diffInMinutes($f[1]) >= $minutes);
                    if ($free) {
                        $task = $tasks->get(count($blocks));
                        $blocks[] = ['title' => $task ? ($ar ? "تركيز: {$task->title}" : "Focus: {$task->title}") : ($ar ? 'فترة تركيز' : 'Focus block'), 'task_id' => $task?->id,
                            'starts_at' => $free[0], 'ends_at' => $free[0]->addMinutes($minutes)];
                        $busy[] = [$free[0], $free[0]->addMinutes($minutes + $c['break'])];
                        break;
                    }
                }
            }
        }
        usort($blocks, fn ($a, $b) => $a['starts_at'] <=> $b['starts_at']);
        $fixed = $occurrences->where('kind', 'fixed')->count();
        $explanation = [
            $ar ? "بقيت كل المواعيد الثابتة ({$fixed}) وغيرها في مكانها؛ الفترات تستخدم الوقت المتاح فقط مع فاصل {$c['break']} دقائق." : "All {$fixed} fixed appointment(s) and other events stay where they are; blocks only use free time, with {$c['break']}-minute buffers.",
            $ar ? 'وُزّعت الفترات على أيام مختلفة أولاً، داخل ساعات تركيزك إن وُجدت.' : 'Blocks are spread across different days first, inside your focus hours when set.',
        ];
        $conflicts = count($blocks) < $count ? [['type' => 'not_enough_time', 'title' => $ar ? 'وقت غير كافٍ' : 'Not enough free time', 'detail' => $ar ? 'وُجدت '.count($blocks)." من {$count} فترات بطول {$minutes} دقيقة." : 'Found '.count($blocks)." of {$count} free {$minutes}-minute slot(s).", 'minutes' => null]] : [];
        $summary = $blocks === []
            ? ($ar ? "لا توجد فترات متاحة بطول {$minutes} دقيقة." : "No free {$minutes}-minute slots were found.")
            : ($ar ? 'اقتراح '.count($blocks)." فترات تركيز ({$minutes} دقيقة)." : 'Suggested '.count($blocks)." focus block(s) of {$minutes} minutes.");
        $proposal = $blocks ? $this->actions->proposeBlocks($user, 'focus_blocks', $provider, $summary, $explanation, $blocks) : null;

        return [
            'message' => $summary, 'proposal' => $proposal?->present(),
            'plan' => ['kind' => 'focus_blocks', 'title' => $ar ? 'فترات تركيز' : 'Focus blocks', 'explanation' => $explanation, 'conflicts' => $conflicts,
                'alternatives' => [['key' => 'short', 'label' => $ar ? 'فترات ٤٥ دقيقة' : '45-minute blocks', 'current' => $alternative === 'short'], ['key' => 'default', 'label' => $ar ? 'المدة المعتادة' : 'Usual length', 'current' => $alternative === 'default'], ['key' => 'long', 'label' => $ar ? 'فترات ٩٠ دقيقة' : '90-minute blocks', 'current' => $alternative === 'long']],
                'impact' => ['blocks' => count($blocks), 'planned_minutes' => count($blocks) * $minutes, 'days' => collect($blocks)->map(fn ($b) => $b['starts_at']->setTimezone($c['tz'])->toDateString())->unique()->count(), 'moved_events' => 0]],
            'state' => ['intent' => 'focus_blocks', 'slots' => ['count' => $count, 'minutes' => $minutes, 'within' => $within, 'alternative' => $alternative]],
        ];
    }

    /**
     * Re-plan a day after an interruption with the day planner (busy-until / time lost), as new blocks around what exists.
     *
     * @param  array{busy_until?: string|null, lost_minutes?: int|null}  $interruption
     * @return array<string, mixed>
     */
    public function reorganizeDay(User $user, bool $ar, string $provider, string $date, array $interruption, bool $askedAboutInterruption, ?string $variant = null): array
    {
        if ($askedAboutInterruption && empty($interruption['busy_until']) && empty($interruption['lost_minutes'])) {
            return $this->clarify($ar, 'reorganize_day', 'interruption', $ar ? 'كم من الوقت ضاع، أو حتى متى أنت مشغول؟' : 'How much time did you lose, or until when are you busy?', [
                ['value' => 'lost:30', 'label' => ['en' => '30 minutes lost', 'ar' => 'ضاعت ٣٠ دقيقة']],
                ['value' => 'lost:60', 'label' => ['en' => 'An hour lost', 'ar' => 'ضاعت ساعة']],
                ['value' => 'lost:120', 'label' => ['en' => 'Two hours lost', 'ar' => 'ضاعت ساعتان']],
                ['value' => 'none', 'label' => ['en' => 'Just re-plan', 'ar' => 'أعد التخطيط فقط']],
            ], ['date' => $date]);
        }
        $plan = $this->day->plan($user, $date, true, $interruption);
        $key = $variant && in_array($variant, DayPlanner::VARIANTS, true) ? $variant : $plan['recommended'];
        $chosen = collect($plan['alternatives'])->firstWhere('key', $key);
        $now = CarbonImmutable::now();
        $items = collect($chosen['items'] ?? [])->filter(fn ($i) => CarbonImmutable::parse($i['starts_at'])->gt($now))->take(self::MAX_BLOCKS)->values();
        $label = CarbonImmutable::parse($date, $plan['timezone'])->locale($ar ? 'ar' : 'en')->translatedFormat('l j F');
        $explanation = array_values(array_filter(array_map(fn ($e) => $e[$ar ? 'ar' : 'en'] ?? null, array_merge($plan['explanation'], $chosen['explanation'] ?? []))));
        $explanation[] = $ar ? 'تبقى المواعيد الحالية في أماكنها؛ تُضاف فترات جديدة في الوقت المتبقي فقط.' : 'Existing events stay where they are; new blocks only use the time that is left.';
        $blocks = $items->map(fn ($i) => ['title' => $i['title'], 'task_id' => $i['task_id'], 'starts_at' => CarbonImmutable::parse($i['starts_at']), 'ends_at' => CarbonImmutable::parse($i['ends_at'])])->all();
        $title = $chosen['title'][$ar ? 'ar' : 'en'] ?? $key;
        $summary = $blocks === []
            ? ($ar ? "لا يتسع يوم {$label} لفترات جديدة بعد المقاطعة." : "{$label} has no room for new blocks after the interruption.")
            : ($ar ? "خطة «{$title}» ليوم {$label}: ".count($blocks).' فترات.' : "“{$title}” plan for {$label}: ".count($blocks).' block(s).');
        $proposal = $blocks ? $this->actions->proposeBlocks($user, 'reorganize_day', $provider, $summary, $explanation, $blocks) : null;

        return [
            'message' => $summary, 'proposal' => $proposal?->present(),
            'plan' => ['kind' => 'reorganize_day', 'title' => $ar ? "إعادة تنظيم {$label}" : "Reorganize {$label}", 'explanation' => array_slice($explanation, 0, 6),
                'conflicts' => array_merge(array_map(fn ($w) => ['type' => 'unscheduled', 'title' => $w['title'], 'detail' => $ar ? $w['reason_ar'] : $w['reason'], 'minutes' => $w['needed_minutes']], $chosen['warnings'] ?? []),
                    $plan['overload'] ? [['type' => 'overloaded', 'title' => $label, 'detail' => $plan['overload'][$ar ? 'ar' : 'en'], 'minutes' => null]] : []),
                'alternatives' => collect($plan['alternatives'])->map(fn ($a) => ['key' => $a['key'], 'label' => $a['title'][$ar ? 'ar' : 'en'], 'current' => $a['key'] === $key, 'planned_minutes' => $a['metrics']['planned_minutes']])->values()->all(),
                'impact' => ['blocks' => count($blocks), 'planned_minutes' => (int) $items->sum('minutes'), 'capacity_minutes' => $plan['budget']['capacity_minutes'], 'must_do_left' => count($chosen['warnings'] ?? [])]],
            'state' => ['intent' => 'reorganize_day', 'slots' => ['date' => $date, 'interruption' => $interruption, 'variant' => $key]],
        ];
    }

    /**
     * @param  list<array{value: string, label: array{en: string, ar: string}}>  $options
     * @param  array<string, mixed>  $slots
     * @return array<string, mixed>
     */
    public function clarify(bool $ar, string $intent, string $slot, string $question, array $options, array $slots = []): array
    {
        return ['message' => $question, 'clarify' => ['intent' => $intent, 'slot' => $slot, 'options' => $options], 'state' => ['intent' => $intent, 'slots' => $slots, 'awaiting' => $slot]];
    }

    /**
     * @return list<string>
     */
    public static function prioritiesIn(string $text): array
    {
        $text = mb_strtolower($text);
        $found = [];
        foreach (['study' => '/stud|learn|course|exam|دراس|مذاكر|تعلم|امتحان/u', 'work' => '/\bwork\b|job|office|عمل|وظيف/u', 'personal' => '/personal|home|family|health|شخصي|منزل|عائل|صحة/u',
            'projects' => '/project|مشروع|مشاريع/u', 'deadlines' => '/deadline|due|موعد نهائي|المواعيد|تسليم/u'] as $key => $pattern) {
            if (preg_match($pattern, $text)) {
                $found[] = $key;
            }
        }

        return $found;
    }

    /**
     * @param  list<string>  $priorities
     * @return list<int>
     */
    private function taskIdsFor(User $user, array $priorities, CarbonImmutable $start, int $days): array
    {
        if ($priorities === []) {
            return [];
        }
        $areas = Category::where('user_id', $user->id)->pluck('area', 'id');
        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get(['id', 'category_id', 'project_id', 'due_at']);

        return $open->filter(function (Task $t) use ($priorities, $areas, $start, $days) {
            $area = $t->category_id ? ($areas[$t->category_id] ?? 'work') : 'work';

            return in_array($area, $priorities, true) || (in_array('projects', $priorities, true) && $t->project_id)
                || (in_array('deadlines', $priorities, true) && $t->due_at && $t->due_at <= $start->addDays($days)->utc());
        })->pluck('id')->values()->all();
    }

    /**
     * @param  list<int>  $priorityIds
     * @return list<int>
     */
    private function essentialIds(User $user, CarbonImmutable $start, int $days, array $priorityIds): array
    {
        return Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])
            ->where(fn ($q) => $q->whereIn('priority', ['urgent', 'high'])->orWhere('due_at', '<=', $start->addDays($days)->utc())->orWhereIn('id', $priorityIds ?: [0]))
            ->limit(500)->pluck('id')->all();
    }

    /**
     * @param  list<string>  $priorities
     * @return list<string>
     */
    private function priorityLabels(array $priorities, bool $ar): array
    {
        $names = ['study' => ['studying', 'الدراسة'], 'work' => ['work', 'العمل'], 'personal' => ['personal life', 'الحياة الشخصية'], 'projects' => ['your projects', 'مشاريعك'], 'deadlines' => ['upcoming deadlines', 'المواعيد القريبة']];

        return array_values(array_map(fn ($p) => $names[$p][$ar ? 1 : 0] ?? $p, $priorities));
    }

    private function range(CarbonImmutable $from, CarbonImmutable $to, bool $ar): string
    {
        return $from->locale($ar ? 'ar' : 'en')->translatedFormat('j M').' – '.$to->locale($ar ? 'ar' : 'en')->translatedFormat('j M');
    }
}
