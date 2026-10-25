<?php

namespace App\Services;

use App\Models\Goal;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;

/**
 * The smallest context an external AI provider needs to answer one message.
 *
 * - Minimal: only sections the question is about (tasks are always included, capped); nothing else by default.
 * - Authorized: the V9 data-source permissions apply (calendar, connected, goals, habits, focus), connected calendar
 *   titles are masked as "Busy" without the `ai_connected_data` consent, and tasks imported from other apps are never sent.
 * - Untrusted: every title is plain data — control characters stripped, length capped — and the prompt says so.
 * - Accountable: `sources` lists what was shared, so the conversation can show it.
 */
class CopilotContext
{
    public const MAX_TASKS = 25;

    public const MAX_EVENTS = 40;

    public const MAX_TEXT = 120;

    /** @var array<string, list<string>> keywords (EN/AR) that make a section relevant */
    private const NEEDS = [
        'calendar' => ['schedule', 'plan', 'calendar', 'meeting', 'event', 'week', 'today', 'tomorrow', 'day', 'time', 'free', 'busy', 'block', 'focus', 'conflict', 'clash', 'overlap', 'deadline', 'reorganize', 'reorganise', 'interrupt', 'appointment', 'morning', 'afternoon', 'evening', 'hour',
            'جدول', 'خطط', 'خطة', 'تقويم', 'اجتماع', 'موعد', 'أسبوع', 'اسبوع', 'اليوم', 'غداً', 'غدا', 'يوم', 'وقت', 'متاح', 'مشغول', 'تركيز', 'تعارض', 'نظم', 'رتب', 'مقاطعة', 'صباح', 'مساء', 'ساعة'],
        'goals' => ['goal', 'objective', 'progress', 'prioriti', 'هدف', 'أهداف', 'اهداف', 'تقدم', 'أولوي', 'اولوي'],
        'projects' => ['project', 'prioriti', 'مشروع', 'مشاريع', 'أولوي', 'اولوي'],
        'habits' => ['habit', 'streak', 'routine', 'عادة', 'عادات', 'سلسلة', 'روتين'],
        'focus' => ['focus', 'productiv', 'week', 'reflect', 'progress', 'how am i', 'review', 'تركيز', 'إنتاج', 'انتاج', 'أسبوع', 'اسبوع', 'تأمل', 'مراجعة', 'تقدم'],
        'workload' => ['plan', 'overload', 'busy', 'week', 'prioriti', 'conflict', 'deadline', 'reorganize', 'reorganise', 'too much', 'خطط', 'خطة', 'مزدحم', 'ضغط', 'أسبوع', 'اسبوع', 'أولوي', 'اولوي', 'تعارض', 'موعد نهائي', 'نظم', 'رتب'],
    ];

    public function __construct(private CalendarService $calendar, private AnalyticsService $analytics, private GoalIntelligence $goals, private IntelligenceService $intelligence) {}

    /**
     * @param  list<array{role: string, content: string}>  $history
     * @return array{data: array<string, mixed>, sources: list<array{source: string, count: int, masked?: int}>, ids: array{tasks: list<int>, goals: list<int>, projects: list<int>}}
     */
    public function build(User $user, string $message, array $history = []): array
    {
        $tz = $user->timezone();
        $now = CarbonImmutable::now($tz);
        $text = mb_strtolower($message.' '.collect($history)->where('role', 'user')->pluck('content')->take(-2)->implode(' '));
        $needs = collect(self::NEEDS)->map(fn (array $words) => collect($words)->contains(fn ($w) => str_contains($text, $w)))->all();
        $allow = fn (string $source) => IntelligenceSettings::source($user, $source);
        $shareConnected = (bool) ($user->preferences()['ai_connected_data'] ?? false);
        $data = ['now' => $now->format('Y-m-d H:i l'), 'timezone' => $tz];
        $sources = [];

        $tasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])
            ->orderByRaw("case priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end")->orderByRaw('due_at IS NULL, due_at ASC')->limit(self::MAX_TASKS)
            ->get(['id', 'title', 'priority', 'status', 'estimated_minutes', 'due_at', 'category_id', 'project_id', 'goal_id']);
        $data['authorized_tasks'] = $tasks->map(fn (Task $t) => ['id' => $t->id, 'title' => self::clean($t->title), 'priority' => $t->priority, 'status' => $t->status, 'estimated_minutes' => $t->estimated_minutes, 'due' => $t->due_at?->setTimezone($tz)->format('Y-m-d H:i')])->all();
        $sources[] = ['source' => 'tasks', 'count' => $tasks->count()];
        $ids = ['tasks' => $tasks->pluck('id')->all(), 'goals' => [], 'projects' => []];

        if ($needs['calendar'] && $allow('calendar')) {
            $events = $this->calendar->occurrences($user, $now->startOfDay()->utc(), $now->startOfDay()->addDays(7)->utc())
                ->filter(fn (array $o) => ($o['source'] ?? 'lifeos') === 'lifeos' || $allow('connected'))->take(self::MAX_EVENTS)->values();
            $masked = 0;
            $data['next_7_days'] = $events->map(function (array $o) use ($tz, $shareConnected, &$masked) {
                $external = ($o['source'] ?? 'lifeos') !== 'lifeos';
                if ($external && ! $shareConnected) {
                    $masked++;
                }

                return ['title' => $external && ! $shareConnected ? 'Busy' : self::clean($o['title']), 'start' => $o['starts_at']->setTimezone($tz)->format('Y-m-d H:i'), 'end' => $o['ends_at']->setTimezone($tz)->format('Y-m-d H:i'), 'fixed' => $o['kind'] === 'fixed'];
            })->all();
            $sources[] = ['source' => 'calendar', 'count' => $events->count(), 'masked' => $masked];
        }
        if ($needs['goals'] && $allow('goals')) {
            $goals = Goal::where('user_id', $user->id)->whereColumn('progress', '<', 'target')->orderByRaw('due_at IS NULL, due_at ASC')->limit(15)->get(['id', 'title', 'due_at', 'progress', 'target']);
            $data['authorized_goals'] = $goals->map(fn (Goal $g) => ['id' => $g->id, 'title' => self::clean($g->title), 'due' => $g->due_at?->setTimezone($tz)->format('Y-m-d'), 'percent' => (int) min(100, round($g->progress / max(1, $g->target) * 100))])->all();
            $ids['goals'] = $goals->pluck('id')->all();
            $sources[] = ['source' => 'goals', 'count' => $goals->count()];
        }
        if ($needs['projects']) {
            $projects = Project::where('user_id', $user->id)->whereNotIn('status', ['completed', 'archived'])->limit(15)->get(['id', 'title']);
            $data['authorized_projects'] = $projects->map(fn (Project $p) => ['id' => $p->id, 'title' => self::clean($p->title)])->all();
            $ids['projects'] = $projects->pluck('id')->all();
            $sources[] = ['source' => 'projects', 'count' => $projects->count()];
        }
        if ($needs['habits'] && $allow('habits')) {
            $habits = $this->goals->habits($user)->take(15);
            $data['habits'] = $habits->map(fn (array $h) => ['title' => self::clean($h['title']), 'streak' => $h['current_streak'], 'done_this_period' => $h['done_this_period'], 'consistency' => $h['consistency']])->values()->all();
            $sources[] = ['source' => 'habits', 'count' => $habits->count()];
        }
        if ($needs['focus'] && $allow('focus')) {
            $data['last_7_days'] = $this->analytics->summary($user, 7)['totals'];
            $sources[] = ['source' => 'focus', 'count' => 1];
        }
        if ($needs['workload']) {
            $snapshot = $this->intelligence->snapshot($user);
            $data['workload_next_7_days'] = collect($snapshot['workload'])->map(fn ($d) => ['date' => $d['date'], 'load_percent' => $d['load_percent'], 'free_minutes' => $d['free_minutes']])->all();
            $sources[] = ['source' => 'workload', 'count' => count($data['workload_next_7_days'])];
        }

        return ['data' => $data, 'sources' => $sources, 'ids' => $ids];
    }

    /**
     * Untrusted text as inert data: no control characters or line breaks, capped length.
     */
    public static function clean(?string $text): string
    {
        $text = preg_replace('/[\x00-\x1F\x7F\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]+/u', ' ', (string) $text) ?? '';

        return mb_substr(trim(preg_replace('/\s+/u', ' ', $text) ?? ''), 0, self::MAX_TEXT);
    }
}
