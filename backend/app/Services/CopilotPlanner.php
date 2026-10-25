<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\Category;
use App\Models\PlanTemplate;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Validation\ValidationException;

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

    public const AREAS = ['work', 'study', 'personal'];

    public function __construct(private PlanningService $planning, private DayPlanner $day, private CalendarService $calendar, private AssistantActions $actions) {}

    public const INTENTS = ['plan_week', 'prioritize', 'focus_blocks', 'reorganize_day', 'use_template'];

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
        // Choices the user did not state come from what they usually choose in this situation (opt-in plan learning),
        // else the defaults.
        $context = PlanLearning::context($user, $intent, $slots);
        $learned = [];
        $scopes = [];
        $learn = function (string $dimension) use ($user, $context, &$learned, &$scopes): ?string {
            $preferred = PlanLearning::preferred($user, $dimension, $context);
            if ($preferred !== null) {
                $learned[$dimension] = $preferred['value'];
                $scopes[$dimension] = $preferred['scope'];
            }

            return $preferred['value'] ?? null;
        };
        $alternative ??= match ($intent) {
            'plan_week', 'prioritize' => $learn('week_version'),
            'focus_blocks' => isset($slots['minutes']) ? null : $learn('focus_length'),
            'reorganize_day' => $learn('day_strategy'),
            default => null,
        };
        // Moving flexible blocks is on unless the user asked to keep everything in place (or usually does).
        $moves = array_key_exists('moves', $slots) && $slots['moves'] !== null ? (bool) $slots['moves'] : (in_array($intent, ['plan_week', 'prioritize', 'reorganize_day'], true) ? $learn('moves') !== 'off' : true);
        $tz = $user->timezone();

        $result = match ($intent) {
            'plan_week' => $this->planWeek($user, $ar, $provider, $priorities, in_array($alternative, ['balanced', 'essentials'], true) ? $alternative : 'balanced', (bool) ($slots['next_week'] ?? false), 'plan_week', $moves),
            'prioritize' => $this->prioritize($user, $ar, $provider, $priorities, (bool) ($slots['next_week'] ?? false), in_array($alternative, ['balanced', 'essentials'], true) ? $alternative : 'balanced', $moves),
            'focus_blocks' => $this->focusBlocks($user, $ar, $provider, (int) ($slots['count'] ?? 3), isset($slots['minutes']) ? (int) $slots['minutes'] : null,
                in_array($slots['within'] ?? null, ['today', 'tomorrow', 'week'], true) ? $slots['within'] : 'week', in_array($alternative, ['short', 'default', 'long'], true) ? $alternative : 'default',
                is_string($slots['area'] ?? null) ? $slots['area'] : null),
            'use_template' => $this->fromTemplate($user, $ar, $provider, (string) ($slots['message'] ?? ''), isset($slots['template_id']) ? (int) $slots['template_id'] : null, (bool) ($slots['next_week'] ?? true)),
            'reorganize_day' => $this->reorganizeDay($user, $ar, $provider, $this->date($slots['date'] ?? null, $tz),
                array_filter(['busy_until' => $slots['interruption']['busy_until'] ?? null, 'lost_minutes' => $slots['interruption']['lost_minutes'] ?? null]),
                (bool) ($slots['ask_interruption'] ?? false), in_array($alternative, DayPlanner::VARIANTS, true) ? $alternative : null, $moves),
        };
        if ($learned !== [] && isset($result['plan'])) {
            $names = ['week_version' => [['balanced' => 'everything by priority', 'essentials' => 'essentials only'], ['balanced' => 'كل الأعمال حسب الأولوية', 'essentials' => 'الأساسيات فقط']],
                'focus_length' => [['short' => '45-minute blocks', 'default' => 'your usual length', 'long' => '90-minute blocks'], ['short' => 'فترات ٤٥ دقيقة', 'default' => 'المدة المعتادة', 'long' => 'فترات ٩٠ دقيقة']],
                'day_strategy' => [['balanced' => 'a balanced day', 'deep' => 'deep focus first', 'light' => 'a light day', 'deadlines' => 'deadlines first'], ['balanced' => 'يوم متوازن', 'deep' => 'التركيز العميق أولاً', 'light' => 'يوم خفيف', 'deadlines' => 'المواعيد النهائية أولاً']],
                'moves' => [['on' => 'moving flexible blocks when needed', 'off' => 'keeping everything in place'], ['on' => 'نقل الفترات المرنة عند الحاجة', 'off' => 'إبقاء كل شيء في مكانه']]];
            $where = [['day_off' => 'on days off', 'workday' => 'on workdays', 'light' => 'in light weeks', 'normal' => 'in normal weeks', 'heavy' => 'in busy weeks'],
                ['day_off' => 'في أيام العطلة', 'workday' => 'في أيام العمل', 'light' => 'في الأسابيع الخفيفة', 'normal' => 'في الأسابيع العادية', 'heavy' => 'في الأسابيع المزدحمة']];
            if (isset($context['day'])) {
                $where[0] = array_merge($where[0], ['light' => 'on light days', 'normal' => 'on normal days', 'heavy' => 'on busy days']);
                $where[1] = array_merge($where[1], ['light' => 'في الأيام الخفيفة', 'normal' => 'في الأيام العادية', 'heavy' => 'في الأيام المزدحمة']);
            }
            $choices = collect($learned)->map(fn ($v, $d) => ($names[$d][$ar ? 1 : 0][$v] ?? $v).($scopes[$d] ? ' ('.$where[$ar ? 1 : 0][$scopes[$d]].')' : ''))->implode($ar ? '، ' : ', ');
            $result['plan']['explanation'][] = $ar ? "استُخدم ما تختاره عادةً: {$choices}. يمكنك تغييره هنا أو إعادة ضبط التعلّم في مركز التحكم بالذكاء الاصطناعي."
                : "Used what you usually choose: {$choices}. Change it here, or reset learning in the AI Control Center.";
            $result['plan']['learned'] = $learned;
            $result['plan']['learned_context'] = array_filter($scopes);
        }
        if ($context !== [] && isset($result['state'])) {
            // The situation this plan was made in, so a choice made on it (or applying it) is learned for that situation.
            $result['state']['learning_context'] = $context;
        }

        return $result;
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
            'plan_week', 'prioritize' => ['priorities' => self::prioritiesIn($text), 'next_week' => $nextWeek, 'alternative' => preg_match('/essential|only the important|الأساسي|الضروري/u', $text) ? 'essentials' : null, 'moves' => self::keepsInPlace($text) ? false : null],
            'focus_blocks' => array_filter([
                'count' => self::countIn($text),
                'minutes' => self::minutesIn($text),
                'within' => $tomorrow ? 'tomorrow' : (preg_match('/\btoday\b|اليوم/u', $text) ? 'today' : 'week'),
                'area' => self::areaIn($text),
            ], fn ($v) => $v !== null),
            'use_template' => ['message' => $message, 'next_week' => ! preg_match('/this week|هذا الأسبوع|هذا الاسبوع/u', $text)],
            'reorganize_day' => [
                'date' => ($tomorrow ? $now->addDay() : $now)->toDateString(),
                'interruption' => array_filter(['busy_until' => self::untilIn($text), 'lost_minutes' => preg_match('/lost|lose|wasted|ضاع|خسرت|فقدت/u', $text) ? self::minutesIn($text) : null]),
                'ask_interruption' => (bool) preg_match('/interrupt|disrupt|derail|emergenc|مقاطع|انقطاع|طارئ/u', $text),
                'moves' => self::keepsInPlace($text) ? false : null,
            ],
            default => [],
        };
    }

    /**
     * "Don't move anything", "keep everything in place", "without moving my events" (fixed appointments are never moved
     * anyway, so "without moving fixed appointments" does not count).
     */
    public static function keepsInPlace(string $text): bool
    {
        return (bool) preg_match('/(don.?t|do not|without|no) mov(e|ing) (anything|any|my|events|blocks|things)(?! ?fixed)|keep (everything|it all|things) (in place|where)|لا تنقل|بدون نقل|دون نقل (أي|شيء)|أبق.? كل شيء/u', mb_strtolower($text));
    }

    /**
     * The area a focus request names: "study blocks", "time for my personal projects", "للدراسة".
     */
    public static function areaIn(string $text): ?string
    {
        return match (true) {
            (bool) preg_match('/stud|learn|course|exam|revis|homework|دراس|مذاكر|تعلم|امتحان/u', $text) => 'study',
            (bool) preg_match('/personal|home|family|hobby|شخصي|منزل|عائل|هواي/u', $text) => 'personal',
            (bool) preg_match('/\bwork\b|working hours|office|job|العمل|ساعات العمل|وظيف/u', $text) => 'work',
            default => null,
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
    public function planWeek(User $user, bool $ar, string $provider, array $priorities = [], string $alternative = 'balanced', bool $nextWeek = false, string $kind = 'plan_week', bool $allowMoves = true): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $start = $nextWeek ? $now->startOfDay()->next(CarbonImmutable::MONDAY) : $now->startOfDay();
        $priorityIds = $this->taskIdsFor($user, $priorities, $start, 7);
        $only = $alternative === 'essentials' ? $this->essentialIds($user, $start, 7, $priorityIds) : [];
        // Moves first: they take flexible blocks off overloaded days, and new blocks are planned around where they land.
        $rebalance = $this->actions->rebalanceMoves($user, $start, 7, $ar);
        $moves = $allowMoves ? $rebalance['actions'] : [];
        $plan = $this->planning->compute($user, $start->toDateString(), 7, $only, $priorityIds, $this->destinations($moves));
        $items = array_slice($plan['items'], 0, self::MAX_BLOCKS);
        $commitments = $this->calendar->occurrences($user, $start->utc(), $start->addDays(7)->utc());
        $fixed = $commitments->where('kind', 'fixed')->count();
        $labels = $this->priorityLabels($priorities, $ar);
        $range = $this->range($start, $start->addDays(6), $ar);

        $explanation = [
            $ar ? "خطة {$range} حول ".$commitments->count()." التزاماً ({$fixed} ثابتاً). الفترات الجديدة تستخدم الوقت المتاح فقط." : "Plan for {$range} around ".$commitments->count()." commitment(s) ({$fixed} fixed). New blocks only use free time.",
            $ar ? 'الفترات ضمن ساعات عملك مع استراحات، والأعمال الكبيرة مقسّمة إلى فترات تركيز.' : 'Blocks stay inside your working hours with breaks; large work is split into focus-sized blocks.',
        ];
        if ($labels) {
            $explanation[] = $ar ? 'خُطّطت أولوياتك أولاً: '.implode('، ', $labels).'.' : 'Your priorities were planned first: '.implode(', ', $labels).'.';
        }
        $explanation = array_merge($explanation, $this->moveExplanation($moves, $rebalance['overloaded'], $allowMoves, $ar));
        if ($alternative === 'essentials') {
            $explanation[] = $ar ? 'نسخة الأساسيات: العاجل والمهم وما يستحق هذا الأسبوع فقط.' : 'Essentials version: only urgent, high-priority and due-this-week work.';
        }
        if (count($plan['items']) > self::MAX_BLOCKS) {
            $explanation[] = $ar ? 'عُرضت أول '.self::MAX_BLOCKS.' فترة؛ اطلب الخطة مجدداً بعد تطبيقها للبقية.' : 'Showing the first '.self::MAX_BLOCKS.' blocks; ask again after applying them for the rest.';
        }
        $blocks = array_map(fn (array $i) => ['title' => $i['title'], 'task_id' => $i['task_id'], 'starts_at' => CarbonImmutable::parse($i['starts_at']), 'ends_at' => CarbonImmutable::parse($i['ends_at'])], $items);
        $summary = match (true) {
            $blocks === [] && $moves === [] => $ar ? "لم يتسع {$range} لفترات جديدة حول التزاماتك." : "{$range} has no room for new blocks around your commitments.",
            $moves === [] => $ar ? 'اقتراح '.count($blocks)." فترة لـ{$range}. راجعها واختر ما تضيفه." : 'Suggested '.count($blocks)." block(s) for {$range}. Review them and choose what to add.",
            default => $ar ? 'اقتراح '.count($blocks).' فترة جديدة ونقل '.count($moves)." فترة مرنة لـ{$range}. راجعها واختر ما تطبّقه." : 'Suggested '.count($blocks).' new block(s) and '.count($moves)." move(s) of flexible blocks for {$range}. Review them and choose what to apply.",
        };
        $proposal = $blocks || $moves ? $this->actions->proposeBlocks($user, $kind, $provider, $summary, $explanation, $blocks, $moves) : null;
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
                    'tasks_unscheduled' => count($plan['warnings']), 'moved_events' => count($moves), 'busiest_day' => $busiest ? ['date' => $busiest['date'], 'load_percent' => $busiest['load_percent']] : null],
                'moves' => $this->movesMeta($moves, $rebalance['actions'], $allowMoves),
            ],
            'state' => ['intent' => $kind, 'slots' => ['priorities' => $priorities, 'alternative' => $alternative, 'next_week' => $nextWeek, 'moves' => $allowMoves]],
        ];
    }

    /**
     * @param  list<string>  $priorities
     * @return array<string, mixed>
     */
    public function prioritize(User $user, bool $ar, string $provider, array $priorities, bool $nextWeek = false, string $alternative = 'balanced', bool $allowMoves = true): array
    {
        if ($priorities === []) {
            return $this->clarify($ar, 'prioritize', 'priorities',
                $ar ? 'ما الذي يجب أن يأتي أولاً؟' : 'What should come first?',
                collect(self::PRIORITIES)->map(fn ($p) => ['value' => $p, 'label' => ['en' => ucfirst($this->priorityLabels([$p], false)[0]), 'ar' => $this->priorityLabels([$p], true)[0]]])->all());
        }

        return $this->planWeek($user, $ar, $provider, $priorities, $alternative, $nextWeek, 'prioritize', $allowMoves);
    }

    /**
     * Find focus blocks in free time only (fixed appointments and every other event stay where they are), in working
     * hours, study hours or personal time. Each area's daily limit counts blocks already booked in that window.
     *
     * @param  string|null  $area  work|study|personal, or null for working and study hours
     * @return array<string, mixed>
     */
    public function focusBlocks(User $user, bool $ar, string $provider, int $count = 3, ?int $minutes = null, string $within = 'week', string $alternative = 'default', ?string $area = null): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $count = max(1, min(6, $count));
        $minutes = match ($alternative) {
            'short' => 45, 'long' => 90, default => max(30, min(180, $minutes ?? max(60, (int) $c['block'])))
        };
        $configured = array_values(array_filter(['study', 'personal'], fn ($a) => ($c["{$a}_start"] ?? null) && ($c["{$a}_end"] ?? null)));
        $area = in_array($area, self::AREAS, true) ? $area : null;
        $missing = $area && $area !== 'work' && ! in_array($area, $configured, true);
        $useAreas = match (true) {
            $area === null => array_merge(['work'], in_array('study', $configured, true) ? ['study'] : []),
            $missing => ['work'],
            default => [$area],
        };
        $first = $within === 'tomorrow' ? $now->startOfDay()->addDay() : $now->startOfDay();
        $days = $within === 'week' ? 7 : 1;
        $occurrences = $this->calendar->occurrences($user, $first->utc(), $first->addDays($days)->utc());
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at']->subMinutes($c['break']), $o['ends_at']->addMinutes($c['break'])])->all();
        $taskBlocks = $occurrences->filter(fn (array $o) => ($o['source'] ?? 'lifeos') === 'lifeos' && ! empty($o['task_id']));
        $earliest = $now->addMinutes(15 - $now->minute % 15)->startOfMinute();
        $areas = Category::where('user_id', $user->id)->pluck('area', 'id');
        $ranked = BriefingService::rank(Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(200)->get(), $now)->pluck('task');
        $tasksFor = fn (string $a) => $area === null ? $ranked->values() : $ranked->filter(fn (Task $t) => ($t->category_id ? ($areas[$t->category_id] ?? 'work') : 'work') === $a)->values();
        $used = [];
        $assigned = [];
        $blocks = [];
        // First pass: at most one block per day, preferring the focus window; second pass fills remaining days.
        foreach ([1, 2] as $perDay) {
            for ($d = 0; $d < $days && count($blocks) < $count; $d++) {
                $day = $first->addDays($d);
                if ($perDay === 1 && collect($blocks)->contains(fn ($b) => $b['starts_at']->setTimezone($c['tz'])->isSameDay($day))) {
                    continue;
                }
                $windows = $this->planning->windows($c, $day);
                foreach ($useAreas as $a) {
                    $window = $windows[$a] ?? null;
                    if (! $window) {
                        continue;
                    }
                    $key = $day->toDateString().$a;
                    $used[$key] ??= (int) $taskBlocks->sum(fn (array $o) => max(0, min($o['ends_at'], $window[1]->utc())->getTimestamp() - max($o['starts_at'], $window[0]->utc())->getTimestamp()) / 60);
                    if ($this->planning->areaLimit($c, $a, $window) < $used[$key] + $minutes) {
                        continue;
                    }
                    $preferred = $a === 'work' && $c['focus_start'] && $c['focus_end'] ? [$day->setTimeFromTimeString($c['focus_start']), $day->setTimeFromTimeString($c['focus_end'])] : null;
                    $slot = null;
                    foreach (array_filter([$preferred, $window]) as [$from, $to]) {
                        $from = max($from, $earliest);
                        $slot = $from < $to ? collect($this->planning->freeIntervals($from->utc(), $to->utc(), $busy))->first(fn ($f) => $f[0]->diffInMinutes($f[1]) >= $minutes) : null;
                        if ($slot) {
                            break;
                        }
                    }
                    if (! $slot) {
                        continue;
                    }
                    // The top task that still has estimated time left after the blocks already given to it.
                    $task = $tasksFor($a)->first(fn (Task $t) => max(0, $t->estimated_minutes - $t->actual_minutes) > ($assigned[$t->id] ?? 0));
                    if ($task) {
                        $assigned[$task->id] = ($assigned[$task->id] ?? 0) + $minutes;
                    }
                    $label = ['work' => ['Focus', 'تركيز'], 'study' => ['Study', 'دراسة'], 'personal' => ['Personal', 'وقت شخصي']][$a];
                    $blocks[] = ['title' => $task ? ($ar ? "{$label[1]}: {$task->title}" : "{$label[0]}: {$task->title}") : ($ar ? "فترة {$label[1]}" : "{$label[0]} block"), 'task_id' => $task?->id,
                        'starts_at' => $slot[0], 'ends_at' => $slot[0]->addMinutes($minutes), 'area' => $a];
                    $busy[] = [$slot[0], $slot[0]->addMinutes($minutes + $c['break'])];
                    $used[$key] += $minutes;
                    break;
                }
            }
        }
        usort($blocks, fn ($a, $b) => $a['starts_at'] <=> $b['starts_at']);
        $fixed = $occurrences->where('kind', 'fixed')->count();
        $names = ['work' => ['working hours', 'ساعات العمل'], 'study' => ['study hours', 'ساعات الدراسة'], 'personal' => ['personal time', 'الوقت الشخصي']];
        $where = implode($ar ? ' و' : ' and ', array_map(fn ($a) => $names[$a][$ar ? 1 : 0], $useAreas));
        $explanation = [
            $ar ? "بقيت كل المواعيد الثابتة ({$fixed}) وغيرها في مكانها؛ الفترات تستخدم الوقت المتاح فقط مع فاصل {$c['break']} دقائق." : "All {$fixed} fixed appointment(s) and other events stay where they are; blocks only use free time, with {$c['break']}-minute buffers.",
            $ar ? "وُزّعت الفترات على أيام مختلفة أولاً، ضمن {$where}." : "Blocks are spread across different days first, inside your {$where}.",
        ];
        foreach (array_intersect(['study', 'personal'], $useAreas) as $a) {
            if ($c["{$a}_limit"] ?? null) {
                $explanation[] = $ar ? "حدّك اليومي لـ{$names[$a][1]} هو {$c["{$a}_limit"]} دقيقة، بما فيه ما هو محجوز مسبقاً." : "Your daily limit for {$names[$a][0]} is {$c["{$a}_limit"]} minutes, including what is already booked.";
            }
        }
        $conflicts = count($blocks) < $count ? [['type' => 'not_enough_time', 'title' => $ar ? 'وقت غير كافٍ' : 'Not enough free time', 'detail' => $ar ? 'وُجدت '.count($blocks)." من {$count} فترات بطول {$minutes} دقيقة." : 'Found '.count($blocks)." of {$count} free {$minutes}-minute slot(s).", 'minutes' => null]] : [];
        if ($missing) {
            $conflicts[] = ['type' => 'no_window', 'title' => $ar ? "لم تحدد {$names[$area][1]}" : "No {$names[$area][0]} set", 'detail' => $ar ? 'استُخدمت ساعات العمل. حدّد الفترة في «خطط يومي» ← الحدود.' : 'Working hours were used instead. Set the window in Plan my day → Boundaries.', 'minutes' => null];
        }
        $summary = $blocks === []
            ? ($ar ? "لا توجد فترات متاحة بطول {$minutes} دقيقة." : "No free {$minutes}-minute slots were found.")
            : ($ar ? 'اقتراح '.count($blocks)." فترات ({$minutes} دقيقة) ضمن {$where}." : 'Suggested '.count($blocks)." block(s) of {$minutes} minutes in your {$where}.");
        $proposal = $blocks ? $this->actions->proposeBlocks($user, 'focus_blocks', $provider, $summary, $explanation, array_map(fn ($b) => array_diff_key($b, ['area' => 1]), $blocks)) : null;
        $alternatives = [['key' => 'short', 'label' => $ar ? 'فترات ٤٥ دقيقة' : '45-minute blocks', 'current' => $alternative === 'short'], ['key' => 'default', 'label' => $ar ? 'المدة المعتادة' : 'Usual length', 'current' => $alternative === 'default'], ['key' => 'long', 'label' => $ar ? 'فترات ٩٠ دقيقة' : '90-minute blocks', 'current' => $alternative === 'long']];
        if ($configured !== []) {
            foreach (array_merge(['work'], $configured) as $a) {
                $alternatives[] = ['key' => "area:{$a}", 'label' => $ar ? 'في '.$names[$a][1] : 'In '.$names[$a][0], 'current' => $area === $a];
            }
        }

        return [
            'message' => $summary, 'proposal' => $proposal?->present(),
            'plan' => ['kind' => 'focus_blocks', 'title' => $ar ? 'فترات تركيز' : 'Focus blocks', 'explanation' => $explanation, 'conflicts' => $conflicts, 'alternatives' => $alternatives,
                'impact' => ['blocks' => count($blocks), 'planned_minutes' => count($blocks) * $minutes, 'days' => collect($blocks)->map(fn ($b) => $b['starts_at']->setTimezone($c['tz'])->toDateString())->unique()->count(), 'moved_events' => 0]],
            'state' => ['intent' => 'focus_blocks', 'slots' => ['count' => $count, 'minutes' => $minutes, 'within' => $within, 'alternative' => $alternative, 'area' => $area]],
        ];
    }

    /**
     * Re-plan a day after an interruption with the day planner (busy-until / time lost), as new blocks around what exists.
     *
     * @param  array{busy_until?: string|null, lost_minutes?: int|null}  $interruption
     * @return array<string, mixed>
     */
    public function reorganizeDay(User $user, bool $ar, string $provider, string $date, array $interruption, bool $askedAboutInterruption, ?string $variant = null, bool $allowMoves = true): array
    {
        if ($askedAboutInterruption && empty($interruption['busy_until']) && empty($interruption['lost_minutes'])) {
            return $this->clarify($ar, 'reorganize_day', 'interruption', $ar ? 'كم من الوقت ضاع، أو حتى متى أنت مشغول؟' : 'How much time did you lose, or until when are you busy?', [
                ['value' => 'lost:30', 'label' => ['en' => '30 minutes lost', 'ar' => 'ضاعت ٣٠ دقيقة']],
                ['value' => 'lost:60', 'label' => ['en' => 'An hour lost', 'ar' => 'ضاعت ساعة']],
                ['value' => 'lost:120', 'label' => ['en' => 'Two hours lost', 'ar' => 'ضاعت ساعتان']],
                ['value' => 'none', 'label' => ['en' => 'Just re-plan', 'ar' => 'أعد التخطيط فقط']],
            ], ['date' => $date]);
        }
        // Flexible blocks caught behind the interruption move to later free time first; the day is then planned around them.
        $displaced = $this->displacedMoves($user, $date, $interruption['busy_until'] ?? null, $ar);
        $moves = $allowMoves ? $displaced : [];
        $plan = $this->day->plan($user, $date, true, $interruption, $this->destinations($moves));
        $key = $variant && in_array($variant, DayPlanner::VARIANTS, true) ? $variant : $plan['recommended'];
        $chosen = collect($plan['alternatives'])->firstWhere('key', $key);
        $now = CarbonImmutable::now();
        $items = collect($chosen['items'] ?? [])->filter(fn ($i) => CarbonImmutable::parse($i['starts_at'])->gt($now))->take(self::MAX_BLOCKS)->values();
        $label = CarbonImmutable::parse($date, $plan['timezone'])->locale($ar ? 'ar' : 'en')->translatedFormat('l j F');
        $explanation = array_values(array_filter(array_map(fn ($e) => $e[$ar ? 'ar' : 'en'] ?? null, array_merge($plan['explanation'], $chosen['explanation'] ?? []))));
        $explanation = array_merge($this->moveExplanation($moves, $displaced === [] ? 0 : 1, $allowMoves, $ar, true), $explanation);
        $explanation[] = $ar ? 'المواعيد الثابتة والمتكررة والمرتبطة تبقى في أماكنها؛ تُضاف فترات جديدة في الوقت المتبقي فقط.' : 'Fixed, recurring and connected events stay where they are; new blocks only use the time that is left.';
        $blocks = $items->map(fn ($i) => ['title' => $i['title'], 'task_id' => $i['task_id'], 'starts_at' => CarbonImmutable::parse($i['starts_at']), 'ends_at' => CarbonImmutable::parse($i['ends_at'])])->all();
        $title = $chosen['title'][$ar ? 'ar' : 'en'] ?? $key;
        $summary = match (true) {
            $blocks === [] && $moves === [] => $ar ? "لا يتسع يوم {$label} لفترات جديدة بعد المقاطعة." : "{$label} has no room for new blocks after the interruption.",
            $moves === [] => $ar ? "خطة «{$title}» ليوم {$label}: ".count($blocks).' فترات.' : "“{$title}” plan for {$label}: ".count($blocks).' block(s).',
            default => $ar ? "خطة «{$title}» ليوم {$label}: ".count($blocks).' فترات جديدة ونقل '.count($moves).' فترة.' : "“{$title}” plan for {$label}: ".count($blocks).' new block(s) and '.count($moves).' move(s).',
        };
        $proposal = $blocks || $moves ? $this->actions->proposeBlocks($user, 'reorganize_day', $provider, $summary, $explanation, $blocks, $moves) : null;

        return [
            'message' => $summary, 'proposal' => $proposal?->present(),
            'plan' => ['kind' => 'reorganize_day', 'title' => $ar ? "إعادة تنظيم {$label}" : "Reorganize {$label}", 'explanation' => array_slice($explanation, 0, 6),
                'conflicts' => array_merge(array_map(fn ($w) => ['type' => 'unscheduled', 'title' => $w['title'], 'detail' => $ar ? $w['reason_ar'] : $w['reason'], 'minutes' => $w['needed_minutes']], $chosen['warnings'] ?? []),
                    $plan['overload'] ? [['type' => 'overloaded', 'title' => $label, 'detail' => $plan['overload'][$ar ? 'ar' : 'en'], 'minutes' => null]] : []),
                'alternatives' => collect($plan['alternatives'])->map(fn ($a) => ['key' => $a['key'], 'label' => $a['title'][$ar ? 'ar' : 'en'], 'current' => $a['key'] === $key, 'planned_minutes' => $a['metrics']['planned_minutes']])->values()->all(),
                'impact' => ['blocks' => count($blocks), 'planned_minutes' => (int) $items->sum('minutes'), 'capacity_minutes' => $plan['budget']['capacity_minutes'], 'must_do_left' => count($chosen['warnings'] ?? []), 'moved_events' => count($moves)],
                'moves' => $this->movesMeta($moves, $displaced, $allowMoves)],
            'state' => ['intent' => 'reorganize_day', 'slots' => ['date' => $date, 'interruption' => $interruption, 'variant' => $key, 'moves' => $allowMoves]],
        ];
    }

    /**
     * Save the new blocks of a proposal as a reusable week template: weekday, local start time, length, title and the
     * task link (kept only while that task is still open when the template is used). Moves are not part of templates.
     *
     * @param  list<string>  $actionIds  optional subset of the proposal's actions
     */
    public function saveTemplate(User $user, AssistantProposal $proposal, string $name, array $actionIds = []): PlanTemplate
    {
        $tz = $user->timezone();
        $blocks = collect($proposal->actions ?? [])->where('type', 'create_event')
            ->when($actionIds !== [], fn ($c) => $c->whereIn('id', $actionIds))
            ->map(function (array $a) use ($tz) {
                $start = CarbonImmutable::parse($a['starts_at'])->setTimezone($tz);

                return ['weekday' => $start->dayOfWeekIso, 'start' => $start->format('H:i'), 'minutes' => (int) max(15, min(AssistantActions::MAX_BLOCK_MINUTES, $a['minutes'] ?? 60)),
                    'title' => mb_substr((string) $a['title'], 0, 200), 'task_id' => $a['task_id'] ?? null];
            })->sortBy(fn ($b) => [$b['weekday'], $b['start']])->values()->take(PlanTemplate::MAX_BLOCKS)->all();
        if ($blocks === []) {
            throw ValidationException::withMessages(['proposal_id' => ['This proposal has no new blocks to save as a template.']]);
        }

        return PlanTemplate::create(['user_id' => $user->id, 'name' => trim($name), 'blocks' => $blocks]);
    }

    /**
     * Plan a week from a saved template as a pending proposal. Blocks that would be in the past or would clash with
     * anything already in the calendar are left out and listed; nothing existing moves.
     *
     * @return array<string, mixed>
     */
    public function fromTemplate(User $user, bool $ar, string $provider, string $message, ?int $templateId = null, bool $nextWeek = true): array
    {
        $templates = PlanTemplate::where('user_id', $user->id)->latest('updated_at')->limit(50)->get();
        if ($templates->isEmpty()) {
            return ['message' => $ar ? 'لا توجد قوالب محفوظة بعد. احفظ خطة كقالب من زر «حفظ كقالب» في أي اقتراح.' : 'You have no saved templates yet. Save a plan as a template with “Save as template” on any proposal.'];
        }
        $text = mb_strtolower($message);
        $template = $templateId ? $templates->firstWhere('id', $templateId)
            : $templates->sortByDesc(fn ($t) => mb_strlen($t->name))->first(fn ($t) => mb_strlen($t->name) >= 2 && str_contains($text, mb_strtolower($t->name)));
        if (! $template && $templates->count() > 1) {
            return $this->clarify($ar, 'use_template', 'template', $ar ? 'أي قالب تريد استخدامه؟' : 'Which template should I use?',
                $templates->take(6)->map(fn ($t) => ['value' => (string) $t->id, 'label' => ['en' => $t->name, 'ar' => $t->name]])->values()->all(), ['next_week' => $nextWeek]);
        }
        $template ??= $templates->first();

        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $monday = $now->startOfWeek(CarbonImmutable::MONDAY)->startOfDay()->addWeeks($nextWeek ? 1 : 0);
        $occurrences = $this->calendar->occurrences($user, $monday->utc(), $monday->addDays(7)->utc());
        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->pluck('id')->flip();
        $blocks = [];
        $skipped = [];
        foreach ($template->blocks as $b) {
            $start = $monday->addDays($b['weekday'] - 1)->setTimeFromTimeString($b['start']);
            $end = $start->addMinutes((int) $b['minutes']);
            $clash = $occurrences->first(fn (array $o) => $o['starts_at'] < $end->utc() && $o['ends_at'] > $start->utc())
                ?? collect($blocks)->first(fn ($x) => $x['starts_at'] < $end && $x['ends_at'] > $start);
            $label = $start->locale($ar ? 'ar' : 'en')->translatedFormat('D H:i');
            if ($start <= $now->addMinutes(5)) {
                $skipped[] = ['type' => 'past', 'title' => $b['title'], 'detail' => $ar ? "{$label} قد مضى." : "{$label} has already passed.", 'minutes' => (int) $b['minutes']];
            } elseif ($clash) {
                $skipped[] = ['type' => 'clash', 'title' => $b['title'], 'detail' => $ar ? "{$label} يتعارض مع «".CopilotContext::clean($clash['title']).'».' : "{$label} clashes with “".CopilotContext::clean($clash['title']).'”.', 'minutes' => (int) $b['minutes']];
            } else {
                $blocks[] = ['title' => $b['title'], 'task_id' => $b['task_id'] && $open->has($b['task_id']) ? $b['task_id'] : null, 'starts_at' => $start, 'ends_at' => $end];
            }
        }
        $range = $this->range($monday, $monday->addDays(6), $ar);
        $explanation = [
            $ar ? "من قالب «{$template->name}»: نفس الأيام والأوقات لأسبوع {$range}." : "From your template “{$template->name}”: the same days and times for {$range}.",
            $ar ? 'لا يُنقل أي موعد قائم؛ تُترك الفترات التي تتعارض مع تقويمك أو التي مضى وقتها.' : 'Nothing already in your calendar moves; blocks that would clash or are already past are left out.',
        ];
        $summary = $blocks === []
            ? ($ar ? "لا يمكن استخدام أي فترة من القالب لأسبوع {$range}." : "None of the template’s blocks fit {$range}.")
            : ($ar ? 'اقتراح '.count($blocks)." فترة من قالب «{$template->name}» لأسبوع {$range}." : 'Suggested '.count($blocks)." block(s) from “{$template->name}” for {$range}.");
        $proposal = $blocks ? $this->actions->proposeBlocks($user, 'template', $provider, $summary, $explanation, $blocks) : null;

        return [
            'message' => $summary, 'proposal' => $proposal?->present(),
            'plan' => ['kind' => 'template', 'title' => $ar ? "قالب «{$template->name}»" : "Template “{$template->name}”", 'explanation' => $explanation, 'conflicts' => $skipped,
                'alternatives' => [['key' => 'week:this', 'label' => $ar ? 'هذا الأسبوع' : 'This week', 'current' => ! $nextWeek], ['key' => 'week:next', 'label' => $ar ? 'الأسبوع القادم' : 'Next week', 'current' => $nextWeek]],
                'impact' => ['blocks' => count($blocks), 'planned_minutes' => (int) collect($blocks)->sum(fn ($b) => $b['starts_at']->diffInMinutes($b['ends_at'])), 'skipped' => count($skipped), 'moved_events' => 0]],
            'state' => ['intent' => 'use_template', 'slots' => ['template_id' => $template->id, 'next_week' => $nextWeek]],
        ];
    }

    /**
     * Moves for flexible blocks that the interruption now overlaps (from now until busy-until, today only): to the
     * first free slot later that day, otherwise the next work days.
     *
     * @return list<array<string, mixed>>
     */
    private function displacedMoves(User $user, string $date, ?string $busyUntil, bool $ar): array
    {
        $c = $this->planning->config($user);
        $day = CarbonImmutable::parse($date, $c['tz'])->startOfDay();
        $now = CarbonImmutable::now($c['tz']);
        if (! $busyUntil || ! $day->isSameDay($now)) {
            return [];
        }
        $until = $day->setTimeFromTimeString($busyUntil);
        $occurrences = $this->calendar->occurrences($user, $day->utc(), $day->addDays(8)->utc());
        $displaced = $this->actions->movable($user, $occurrences)->filter(fn (array $o) => $o['starts_at'] < $until->utc() && $o['starts_at']->setTimezone($c['tz'])->isSameDay($day))
            ->sortBy(fn (array $o) => $o['starts_at']->getTimestamp())->take(AssistantActions::MAX_MOVES);
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at']->subMinutes($c['buffer']), $o['ends_at']->addMinutes($c['buffer'])])->all();
        $moves = [];
        foreach ($displaced as $o) {
            $minutes = (int) $o['starts_at']->diffInMinutes($o['ends_at']);
            $slot = null;
            for ($d = 0; $d < 8 && ! $slot; $d++) {
                $target = $day->addDays($d);
                foreach ($this->planning->windows($c, $target) as $window) {
                    $from = max($window[0], $d === 0 ? $until : $window[0], $now->addMinutes(15));
                    $free = $from < $window[1] ? collect($this->planning->freeIntervals($from->utc(), $window[1]->utc(), $busy))->first(fn ($f) => $f[0]->diffInMinutes($f[1]) >= $minutes) : null;
                    if ($free) {
                        $slot = [$free[0], $free[0]->addMinutes($minutes)];
                        break;
                    }
                }
            }
            if (! $slot) {
                continue;
            }
            $busy[] = [$slot[0]->subMinutes($c['buffer']), $slot[1]->addMinutes($c['buffer'])];
            $when = $slot[0]->setTimezone($c['tz']);
            $reason = $ar
                ? "«{$o['title']}» كانت ضمن وقت المقاطعة؛ تنتقل إلى ".$when->locale('ar')->translatedFormat($when->isSameDay($day) ? 'H:i' : 'l H:i').'.'
                : "“{$o['title']}” fell inside the interruption; it moves to ".$when->format($when->isSameDay($day) ? 'H:i' : 'l H:i').'.';
            $moves[] = $this->actions->moveAction($user, $o, $slot[0], $slot[1], $reason, 'm'.(count($moves) + 1));
        }

        return $moves;
    }

    /**
     * Where proposed moves will land, reserved so new blocks are planned around them.
     *
     * @param  list<array<string, mixed>>  $moves
     * @return list<array{0: CarbonImmutable, 1: CarbonImmutable}>
     */
    private function destinations(array $moves): array
    {
        return array_map(fn (array $m) => [CarbonImmutable::parse($m['starts_at']), CarbonImmutable::parse($m['ends_at'])], $moves);
    }

    /**
     * @param  list<array<string, mixed>>  $moves
     * @return list<string>
     */
    private function moveExplanation(array $moves, int $pressure, bool $allowed, bool $ar, bool $interruption = false): array
    {
        if ($moves !== []) {
            return [$ar
                ? 'تنتقل '.count($moves).' فترة مرنة '.($interruption ? 'خارج وقت المقاطعة' : 'من الأيام المزدحمة').'. لا تُنقل المواعيد الثابتة أو المتكررة أو المرتبطة أبداً، والوقت الذي تحرّره لا يُستخدم في هذا الاقتراح.'
                : count($moves).' flexible block(s) move '.($interruption ? 'out of the interruption' : 'off overloaded days').'. Fixed, recurring and connected events never move, and the time a move frees is not reused in this proposal.'];
        }
        if (! $allowed && $pressure > 0) {
            return [$ar ? 'طلبت إبقاء كل شيء في مكانه، لذلك لا تُنقل أي فترة.' : 'You asked to keep everything in place, so nothing moves.'];
        }

        return [];
    }

    /**
     * @param  list<array<string, mixed>>  $moves
     * @param  list<array<string, mixed>>  $possible  moves the plan would make if allowed
     * @return array{allowed: bool, count: int, available: int}
     */
    private function movesMeta(array $moves, array $possible, bool $allowed): array
    {
        return ['allowed' => $allowed, 'count' => count($moves), 'available' => count($possible)];
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
