<?php

namespace App\Services;

use App\Models\Goal;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * Read-only Copilot answers computed from the user's own data: filtered queries, priority explanations, conflict
 * detection and weekly reflection. Nothing here changes data; changes go through AssistantActions proposals.
 */
class CopilotService
{
    public const ENTITIES = ['tasks', 'projects', 'goals'];

    public const DUE_FILTERS = ['overdue', 'today', 'tomorrow', 'week', 'none'];

    public const STATUS_FILTERS = ['open', 'in_progress', 'completed', 'at_risk'];

    public function __construct(private BriefingService $briefing, private GoalIntelligence $goals, private PlanningService $planning, private CalendarService $calendar, private WeeklyReviewService $weekly, private CheckinService $checkins) {}

    /**
     * Recognize "show my high priority tasks for project Website due this week" style questions (English and Arabic).
     * Returns null when the message is not a list query.
     *
     * @return array{entity: string, due: string|null, priority: string|null, status: string|null}|null
     */
    public function parseQuery(string $message): ?array
    {
        $text = mb_strtolower($message);
        $has = fn (string $pattern) => preg_match($pattern, $text) === 1;
        $entity = match (true) {
            $has('/\btasks?\b|\bto-?dos?\b|مهام|المهام|مهماتي|مهامي/u') => 'tasks',
            $has('/\bgoals?\b|أهداف|اهداف|أهدافي|اهدافي/u') => 'goals',
            $has('/\bprojects?\b|مشاريع|المشاريع|مشاريعي/u') => 'projects',
            default => null,
        };
        if ($entity === null) {
            return null;
        }
        $due = match (true) {
            $has('/overdue|\blate\b|متأخر/u') => 'overdue',
            $has('/\btoday\b|اليوم/u') => 'today',
            $has('/tomorrow|غدا|غداً|بكرة|بكره/u') => 'tomorrow',
            $has('/this week|next 7 days|next seven days|\bweek\b|الأسبوع|الاسبوع|أسبوع|اسبوع/u') => 'week',
            $has('/no (?:deadline|due date)|without (?:a )?(?:deadline|due date)|بلا موعد|بدون موعد/u') => 'none',
            default => null,
        };
        $priority = match (true) {
            $has('/urgent|عاجل/u') => 'urgent',
            $has('/high[- ]priority|\bhigh\b|important|عالية|مهمة جدا|المهمة جدا/u') => 'high',
            $has('/low[- ]priority|\blow\b|منخفضة/u') => 'low',
            default => null,
        };
        $status = match (true) {
            $has('/at risk|\brisk|behind|off track|في خطر|خطر|متعثر/u') => 'at_risk',
            $has('/in progress|started|قيد التنفيذ|بدأت/u') => 'in_progress',
            $has('/completed|\bdone\b|finished|منجزة|المنجزة|مكتملة|أنجزت|انجزت/u') => 'completed',
            default => null,
        };
        $verb = $has('/\b(show|list|which|what are|what\'s|display|find|give me|see|how many)\b|اعرض|أعرض|أظهر|اظهر|ما هي|ماهي|ما هم|قائمة|أرني|ارني|كم/u');
        $scoped = $has('/\b(for|in|on) (?:the )?(?:project|goal)\b|(?:project|goal) [\p{L}\d]|لمشروع|في مشروع|للهدف|لهدف|مشروع |هدف /u');
        if (! $verb && ! $scoped && $due === null && $priority === null && $status === null) {
            return null;
        }
        if ($entity === 'tasks' && $due === 'overdue' && ! $scoped && $priority === null && $status === null) {
            return null;
        }

        return ['entity' => $entity, 'due' => $due, 'priority' => $priority, 'status' => $status];
    }

    /**
     * Filtered list of the user's tasks, projects or goals. Project and goal references are resolved only among the
     * user's own records, by id (from a provider) or by title found in the message.
     *
     * @param  array{entity?: string, due?: string|null, priority?: string|null, status?: string|null, project_id?: int|null, goal_id?: int|null}  $filters
     * @return array{message: string, tasks: list<array<string, mixed>>, items: list<array<string, mixed>>}
     */
    public function query(User $user, array $filters, bool $ar, string $message = ''): array
    {
        $entity = in_array($filters['entity'] ?? null, self::ENTITIES, true) ? $filters['entity'] : 'tasks';
        $tz = $user->timezone();
        $now = CarbonImmutable::now($tz);
        $project = $this->resolve(Project::class, $user, $filters['project_id'] ?? null, $entity === 'tasks' ? $message : '');
        $goal = $this->resolve(Goal::class, $user, $filters['goal_id'] ?? null, $entity === 'tasks' ? $message : '');
        $due = in_array($filters['due'] ?? null, self::DUE_FILTERS, true) ? $filters['due'] : null;
        $priority = in_array($filters['priority'] ?? null, ['urgent', 'high', 'medium', 'low'], true) ? $filters['priority'] : null;
        $status = in_array($filters['status'] ?? null, self::STATUS_FILTERS, true) ? $filters['status'] : null;

        if ($entity !== 'tasks') {
            return $this->healthQuery($user, $entity, $status, $due, $ar, $now);
        }

        $query = Task::where('user_id', $user->id);
        $status === 'completed' ? $query->where('status', 'completed') : $query->whereNotIn('status', ['completed', 'cancelled']);
        if ($status === 'in_progress') {
            $query->where('status', 'in_progress');
        }
        if ($project) {
            $query->where('project_id', $project->id);
        }
        if ($goal) {
            $query->where('goal_id', $goal->id);
        }
        if ($priority) {
            $query->whereIn('priority', $priority === 'high' ? ['urgent', 'high'] : [$priority]);
        }
        $dateColumn = $status === 'completed' ? 'completed_at' : 'due_at';
        match ($due) {
            'overdue' => $query->where('due_at', '<', $now->utc()),
            'today' => $query->whereBetween($dateColumn, [$now->startOfDay()->utc(), $now->endOfDay()->utc()]),
            'tomorrow' => $query->whereBetween($dateColumn, [$now->addDay()->startOfDay()->utc(), $now->addDay()->endOfDay()->utc()]),
            'week' => $status === 'completed' ? $query->where('completed_at', '>=', $now->subDays(7)->utc()) : $query->whereBetween('due_at', [$now->startOfDay()->utc(), $now->addDays(7)->endOfDay()->utc()]),
            'none' => $query->whereNull('due_at'),
            default => null,
        };
        $tasks = $query->limit(500)->get();
        $rows = $status === 'completed'
            ? $tasks->sortByDesc('completed_at')->map(fn (Task $t) => ['task' => $t, 'reasons' => []])
            : BriefingService::rank($tasks, $now, $this->goals->pressure($user));
        $rows = $rows->take(15)->values();

        $scope = collect([
            $priority ? ($ar ? ['urgent' => 'العاجلة', 'high' => 'ذات الأولوية العالية', 'medium' => 'المتوسطة', 'low' => 'المنخفضة'][$priority] : $priority.' priority') : null,
            $status === 'in_progress' ? ($ar ? 'قيد التنفيذ' : 'in progress') : null,
            $project ? ($ar ? "في مشروع «{$project->title}»" : "in project “{$project->title}”") : null,
            $goal ? ($ar ? "للهدف «{$goal->title}»" : "for goal “{$goal->title}”") : null,
            $due ? $this->dueLabel($due, $status === 'completed', $ar) : null,
        ])->filter()->implode($ar ? ' ' : ', ');
        $noun = $status === 'completed' ? ($ar ? 'مهمة منجزة' : 'completed task(s)') : ($ar ? 'مهمة مفتوحة' : 'open task(s)');
        if ($rows->isEmpty()) {
            return ['message' => $ar ? "لا توجد {$noun}".($scope ? " {$scope}" : '').'.' : "No {$noun}".($scope ? " {$scope}" : '').'.', 'tasks' => [], 'items' => []];
        }
        $minutes = (int) $rows->sum(fn (array $r) => $r['task']->estimated_minutes);
        $lines = $rows->values()->map(fn (array $r, int $i) => ($i + 1).'. '.$r['task']->title.($r['task']->due_at ? ' — '.$r['task']->due_at->setTimezone($tz)->locale($ar ? 'ar' : 'en')->translatedFormat('D j M H:i') : ''))->implode("\n");
        $count = $tasks->count();
        $head = $ar ? "{$count} {$noun}".($scope ? " {$scope}" : '').($status === 'completed' ? ':' : " (نحو {$minutes} دقيقة في المعروض)، مرتبة حسب الأولوية:") : "{$count} {$noun}".($scope ? " {$scope}" : '').($status === 'completed' ? ':' : " (about {$minutes} min shown), ranked by priority:");
        $more = $count > $rows->count() ? ($ar ? "\n… و".($count - $rows->count()).' أخرى.' : "\n… and ".($count - $rows->count()).' more.') : '';

        return ['message' => "{$head}\n{$lines}{$more}", 'tasks' => $rows->map(fn (array $r) => $this->taskSummary($r['task'], $r['reasons']))->values()->all(), 'items' => []];
    }

    /**
     * @return array{message: string, tasks: list<array<string, mixed>>, items: list<array<string, mixed>>}
     */
    private function healthQuery(User $user, string $entity, ?string $status, ?string $due, bool $ar, CarbonImmutable $now): array
    {
        $rows = $entity === 'goals' ? $this->goals->goals($user) : $this->goals->projects($user);
        if ($status === 'at_risk') {
            $rows = $rows->filter(fn (array $r) => in_array($r['status'], ['at_risk', 'behind', 'overdue', 'attention'], true));
        } elseif ($status === 'completed') {
            $rows = $rows->filter(fn (array $r) => $r['status'] === 'completed');
        } else {
            $rows = $rows->reject(fn (array $r) => in_array($r['status'], ['completed', 'paused'], true));
        }
        if ($due !== null && $due !== 'none') {
            $until = match ($due) {
                'overdue' => $now, 'today' => $now->endOfDay(), 'tomorrow' => $now->addDay()->endOfDay(), default => $now->addDays(7)->endOfDay(),
            };
            $rows = $rows->filter(fn (array $r) => ! empty($r['due_at']) && CarbonImmutable::parse($r['due_at']) <= $until);
        } elseif ($due === 'none') {
            $rows = $rows->filter(fn (array $r) => empty($r['due_at']));
        }
        $rows = $rows->values();
        $statusLabel = fn (string $s) => $ar
            ? (['on_track' => 'على المسار', 'at_risk' => 'في خطر', 'behind' => 'متأخر', 'overdue' => 'تجاوز الموعد', 'completed' => 'مكتمل', 'no_deadline' => 'بلا موعد', 'healthy' => 'سليم', 'attention' => 'يحتاج اهتماماً', 'paused' => 'متوقف'][$s] ?? $s)
            : str_replace('_', ' ', $s);
        $noun = $entity === 'goals' ? ($ar ? 'هدف' : 'goal(s)') : ($ar ? 'مشروع' : 'project(s)');
        if ($rows->isEmpty()) {
            return ['message' => $status === 'at_risk' ? ($ar ? "لا يوجد {$noun} يحتاج تدخلاً الآن." : "No {$noun} need attention right now.") : ($ar ? "لا يوجد {$noun} مطابق." : "No matching {$noun}."), 'tasks' => [], 'items' => []];
        }
        $items = $rows->take(15)->map(function (array $r) use ($entity, $ar, $statusLabel) {
            $reason = $r['reasons'][0] ?? null;
            $reason = is_array($reason) ? $reason[$ar ? 'ar' : 'en'] : null;
            $detail = $entity === 'goals'
                ? ($r['percent'].'%'.($r['days_left'] !== null ? ($ar ? " · متبقٍ {$r['days_left']} يوم" : " · {$r['days_left']} day(s) left") : ''))
                : (($ar ? "{$r['open']} مفتوحة" : "{$r['open']} open").($r['overdue'] ? ($ar ? " · {$r['overdue']} متأخرة" : " · {$r['overdue']} overdue") : ''));

            return ['type' => $entity === 'goals' ? 'goal' : 'project', 'id' => $r['id'], 'title' => $r['title'], 'status' => $r['status'], 'status_label' => $statusLabel($r['status']), 'detail' => $detail.($reason ? ' · '.$reason : ''), 'link' => $entity === 'goals' ? '/goals' : "/projects/{$r['id']}"];
        })->all();
        $lines = collect($items)->map(fn (array $i) => "• {$i['title']} — {$i['status_label']} ({$i['detail']})")->implode("\n");

        return ['message' => ($ar ? "{$rows->count()} {$noun}:" : "{$rows->count()} {$noun}:")."\n{$lines}", 'tasks' => [], 'items' => $items];
    }

    /**
     * Why a task ranks where it does: the scoring factors, its position, and what outranks it.
     *
     * @return array{message: string, tasks: list<array<string, mixed>>, items: list<array<string, mixed>>}
     */
    public function explain(User $user, string $message, bool $ar, ?int $taskId = null): array
    {
        $now = CarbonImmutable::now($user->timezone());
        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->limit(500)->get();
        if ($open->isEmpty()) {
            return ['message' => $ar ? 'لا توجد مهام مفتوحة لشرح ترتيبها.' : 'You have no open tasks to explain.', 'tasks' => [], 'items' => []];
        }
        $pressure = $this->goals->pressure($user);
        $ranked = BriefingService::rank($open, $now, $pressure)->values();
        $task = $taskId ? $open->firstWhere('id', $taskId) : $this->matchTitle($open, $message);
        $index = $task ? $ranked->search(fn (array $r) => $r['task']->id === $task->id) : 0;
        $row = $ranked[$index];
        $task = $row['task'];
        $score = $row['score'];
        $reasons = collect($row['reasons'])->map(fn (string $r) => AssistantService::REASONS[$r][$ar ? 1 : 0] ?? $r);
        $position = $index + 1;
        $tz = $user->timezone();
        $facts = collect([
            $ar ? 'الأولوية: '.['urgent' => 'عاجلة', 'high' => 'عالية', 'medium' => 'متوسطة', 'low' => 'منخفضة'][$task->priority] : "Priority: {$task->priority}",
            $task->due_at ? ($ar ? 'الموعد: '.$task->due_at->setTimezone($tz)->locale('ar')->translatedFormat('l j F H:i') : 'Due: '.$task->due_at->setTimezone($tz)->format('D j M H:i')) : ($ar ? 'بلا موعد نهائي' : 'No deadline'),
            $ar ? "التقدير: {$task->estimated_minutes} دقيقة" : "Estimate: {$task->estimated_minutes} min",
            $task->goal_id && isset($pressure[$task->goal_id]) ? ($ar ? 'مرتبطة بهدف يحتاج اهتماماً' : 'Linked to a goal that needs attention') : null,
            $task->status === 'in_progress' ? ($ar ? 'بدأت العمل عليها بالفعل' : 'Already in progress') : null,
        ])->filter()->map(fn (string $f) => "• {$f}")->implode("\n");
        $intro = $ar
            ? "«{$task->title}» في المرتبة {$position} من {$ranked->count()} مهمة مفتوحة (درجة {$score})".($reasons->isNotEmpty() ? ' لأنها '.$reasons->implode('، ') : '').'.'
            : "“{$task->title}” ranks #{$position} of {$ranked->count()} open tasks (score {$score})".($reasons->isNotEmpty() ? ' because it is '.$reasons->implode(', ') : '').'.';
        $ahead = $ranked->take(min(3, $index))->map(fn (array $r) => '• '.$r['task']->title.' ('.collect($r['reasons'])->map(fn (string $x) => AssistantService::REASONS[$x][$ar ? 1 : 0] ?? $x)->implode($ar ? '، ' : ', ').')');
        $aheadText = $ahead->isNotEmpty() ? ($ar ? "\n\nيسبقها:\n" : "\n\nAhead of it:\n").$ahead->implode("\n") : '';
        $how = $ar
            ? "\n\nيجمع الترتيب بين الأولوية وقرب الموعد والتأخر والتقدم الحالي وضغط الأهداف والمهام السريعة. غيّر الأولوية أو الموعد لتغيير الترتيب."
            : "\n\nRanking combines priority, deadline proximity, lateness, work already started, goal pressure and quick wins. Change the priority or deadline to change its place.";

        return ['message' => "{$intro}\n{$facts}{$aheadText}{$how}", 'tasks' => [$this->taskSummary($task, $row['reasons'])], 'items' => []];
    }

    /**
     * Calendar overlaps, overloaded days and deadlines that don't fit the free time before them (next 7 days).
     *
     * @return array{message: string, tasks: list<array<string, mixed>>, items: list<array<string, mixed>>}
     */
    public function conflicts(User $user, bool $ar): array
    {
        $c = $this->planning->config($user);
        $tz = $c['tz'];
        $first = CarbonImmutable::now($tz)->startOfDay();
        $occurrences = $this->calendar->occurrences($user, CarbonImmutable::now()->utc(), $first->addDays(7)->utc())->values();
        $fmt = fn (CarbonImmutable $d) => $d->setTimezone($tz)->locale($ar ? 'ar' : 'en')->translatedFormat($ar ? 'l H:i' : 'D H:i');
        $items = [];
        for ($i = 0; $i < $occurrences->count(); $i++) {
            for ($j = $i + 1; $j < $occurrences->count() && $occurrences[$j]['starts_at'] < $occurrences[$i]['ends_at']; $j++) {
                [$a, $b] = [$occurrences[$i], $occurrences[$j]];
                $items[] = ['type' => 'overlap', 'title' => "{$a['title']} ↔ {$b['title']}", 'detail' => $fmt(max($a['starts_at'], $b['starts_at'])).($ar ? ' · تداخل ' : ' · overlap ').(int) max($a['starts_at'], $b['starts_at'])->diffInMinutes(min($a['ends_at'], $b['ends_at'])).($ar ? ' دقيقة' : ' min'), 'link' => '/calendar'];
            }
        }
        $summary = $this->planning->summary($user, $first, 7, [], [], $c);
        $days = collect($summary['days']);
        foreach ($days->where('overloaded', true) as $day) {
            $items[] = ['type' => 'overload', 'title' => CarbonImmutable::parse($day['date'], $tz)->locale($ar ? 'ar' : 'en')->translatedFormat('l j M'), 'detail' => $ar ? "محجوز بنسبة {$day['load_percent']}٪ من ساعات العمل" : "{$day['load_percent']}% booked against working hours", 'link' => '/calendar'];
        }
        $due = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereBetween('due_at', [CarbonImmutable::now()->utc(), $first->addDays(7)->utc()])->orderBy('due_at')->limit(50)->get();
        $need = 0;
        $risky = 0;
        foreach ($due as $task) {
            $need += max(0, $task->estimated_minutes - (int) $task->actual_minutes);
            $dueDay = $task->due_at->setTimezone($tz)->toDateString();
            $free = (int) $days->filter(fn (array $d) => $d['date'] < $dueDay)->sum('free_minutes') + (int) round(($days->firstWhere('date', $dueDay)['free_minutes'] ?? 0) / 2);
            if ($need > $free && ++$risky > 3) {
                continue;
            }
            if ($need > $free) {
                $items[] = ['type' => 'deadline', 'id' => $task->id, 'title' => $task->title, 'detail' => $ar ? "مستحقة {$fmt($task->due_at)}: تحتاج المهام حتى هذا الموعد نحو {$need} دقيقة، والمتاح نحو {$free}" : "Due {$fmt($task->due_at)}: work due by then needs ~{$need} min, about {$free} min is free", 'link' => '/tasks?due=week'];
            }
        }
        if ($risky > 3) {
            // Once one deadline doesn't fit, every later one inherits the shortfall; list the first three and summarise.
            $items[] = ['type' => 'deadline', 'title' => $ar ? 'ومواعيد أخرى' : 'And more deadlines', 'detail' => $ar ? ($risky - 3).' مهمة أخرى مستحقة بعدها تعتمد على الوقت نفسه' : ($risky - 3).' more task(s) due after these compete for the same time', 'link' => '/tasks?due=week'];
        }
        $counts = collect($items)->countBy('type');
        $counts['deadline'] = $risky ?: ($counts['deadline'] ?? 0);
        if ($items === []) {
            return ['message' => $ar ? 'لا توجد تعارضات خلال الأيام السبعة القادمة: لا تداخل في التقويم، ولا يوم مزدحم، والمواعيد تتسع في وقتك المتاح.' : 'No conflicts in the next 7 days: nothing overlaps, no day is overloaded and deadlines fit your free time.', 'tasks' => [], 'items' => []];
        }
        $parts = collect([
            $counts['overlap'] ?? 0 ? ($ar ? "{$counts['overlap']} تداخل في التقويم" : "{$counts['overlap']} calendar overlap(s)") : null,
            $counts['overload'] ?? 0 ? ($ar ? "{$counts['overload']} يوم مزدحم" : "{$counts['overload']} overloaded day(s)") : null,
            $counts['deadline'] ?? 0 ? ($ar ? "{$counts['deadline']} موعد قد لا يتسع له الوقت" : "{$counts['deadline']} deadline(s) that may not fit") : null,
        ])->filter()->implode($ar ? '، ' : ', ');
        $lines = collect($items)->map(fn (array $i) => "• {$i['title']} — {$i['detail']}")->implode("\n");
        $advice = $ar
            ? "\n\nيمكنني اقتراح نقل الفترات المرنة («أعد توازن أسبوعي») أو تخطيط يومك. لن يتغير شيء دون موافقتك."
            : "\n\nI can propose moving flexible blocks (“Rebalance my week”) or plan your day. Nothing changes without your approval.";

        return ['message' => ($ar ? "وجدت خلال الأيام السبعة القادمة: {$parts}." : "In the next 7 days I found {$parts}.")."\n{$lines}{$advice}", 'tasks' => [], 'items' => $items];
    }

    /**
     * Reflection prompts grounded in this week's data, plus a short progress summary.
     *
     * @return array{message: string, tasks: list<array<string, mixed>>, items: list<array<string, mixed>>}
     */
    public function reflection(User $user, bool $ar): array
    {
        $start = $this->weekly->weekStart($user, CarbonImmutable::now($user->timezone())->toDateString());
        $week = $this->weekly->build($user, $start);
        $m = $week['metrics'];
        $lines = [$ar ? 'هذا الأسبوع حتى الآن:' : 'This week so far:'];
        $lines[] = $ar ? "• أنجزت {$m['completed']} مهمة، وبقيت {$m['unfinished']}." : "• {$m['completed']} task(s) completed, {$m['unfinished']} still open.";
        $hours = round($m['focus_minutes'] / 60, 1);
        $lines[] = $ar ? "• تركيز: {$hours} ساعة".($m['previous_focus_minutes'] >= 60 && $m['focus_change'] !== null ? " ({$m['focus_change']}٪ مقارنة بالأسبوع الماضي)" : '').'.' : "• Focus: {$hours}h".($m['previous_focus_minutes'] >= 60 && $m['focus_change'] !== null ? " ({$m['focus_change']}% vs last week)" : '').'.';
        if ($m['habit_consistency'] !== null) {
            $lines[] = $ar ? "• انتظام العادات: {$m['habit_consistency']}٪." : "• Habit consistency: {$m['habit_consistency']}%.";
        }
        $risky = collect($week['goal_health'])->whereIn('status', ['at_risk', 'behind', 'overdue']);
        if ($risky->isNotEmpty()) {
            $lines[] = $ar ? '• أهداف تحتاج اهتماماً: '.$risky->pluck('title')->implode('، ').'.' : '• Goals needing attention: '.$risky->pluck('title')->implode(', ').'.';
        }

        $prompts = [];
        $wins = collect($week['completed'])->sortByDesc(fn (array $t) => ['urgent' => 3, 'high' => 2, 'medium' => 1][$t['priority']] ?? 0)->take(2)->pluck('title');
        $prompts[] = $wins->isNotEmpty()
            ? ($ar ? 'ما الذي ساعدك على إنجاز «'.$wins->implode('» و«').'»؟ كيف تكرره؟' : 'What helped you finish “'.$wins->implode('” and “').'”? How can you repeat it?')
            : ($ar ? 'ما أصغر خطوة كان يمكن أن تحرّك أسبوعك للأمام؟' : 'What is the smallest step that would have moved your week forward?');
        $overdue = collect($week['unfinished'])->where('overdue', true);
        if ($overdue->isNotEmpty()) {
            $prompts[] = $ar ? "تأخرت {$overdue->count()} مهمة. ما الذي أعاقها: الوقت، أم الوضوح، أم الأولوية؟ وأيها يمكن إلغاؤه؟" : "{$overdue->count()} task(s) slipped past their deadline. What got in the way: time, clarity or priority? Which can you drop?";
        }
        if ($m['estimate_overruns'] > 0) {
            $prompts[] = $ar ? "تجاوزت {$m['estimate_overruns']} مهمة تقديرها بكثير. ما الذي لم تتوقعه؟" : "{$m['estimate_overruns']} task(s) ran well over estimate. What did you not anticipate?";
        }
        $finding = collect($this->checkins->enabled($user) ? $this->checkins->insights($user, 30)['findings'] : [])->first();
        if ($finding) {
            $prompts[] = ($ar ? 'من تسجيلاتك: ' : 'From your check-ins: ').$finding[$ar ? 'ar' : 'en'].($ar ? ' كيف تستفيد من ذلك الأسبوع القادم؟' : ' How could you use that next week?');
        }
        if ($risky->isNotEmpty()) {
            $prompts[] = $ar ? "ما الخطوة الواحدة التي ستحرّك «{$risky->first()['title']}» الأسبوع القادم؟" : "What single step will move “{$risky->first()['title']}” next week?";
        }
        $prompts[] = $ar ? 'ما الذي ستتوقف عن فعله الأسبوع القادم لتفسح وقتاً لما يهم؟' : 'What will you stop doing next week to make room for what matters?';

        $text = implode("\n", $lines)."\n\n".($ar ? 'أسئلة للتأمل:' : 'Questions to reflect on:')."\n".collect($prompts)->take(5)->map(fn (string $p) => "• {$p}")->implode("\n")
            ."\n\n".($ar ? 'دوّن إجاباتك في المراجعة الأسبوعية.' : 'Capture your answers in the weekly review.');

        return ['message' => $text, 'tasks' => [], 'items' => [['type' => 'link', 'title' => $ar ? 'افتح المراجعة الأسبوعية' : 'Open weekly review', 'detail' => '', 'link' => '/review']]];
    }

    /**
     * Find the goal a planning request refers to: by id, by title in the message, or the goal under most pressure.
     */
    public function goalFor(User $user, string $message, ?int $goalId = null): ?Goal
    {
        $goals = Goal::where('user_id', $user->id)->limit(200)->get();
        if ($goalId && ($goal = $goals->firstWhere('id', $goalId))) {
            return $goal;
        }
        if ($goal = $this->matchTitle($goals, $message)) {
            return $goal;
        }
        $pressure = $this->goals->pressure($user);
        arsort($pressure);
        $id = array_key_first($pressure);

        return $id ? $goals->firstWhere('id', $id) : $goals->filter(fn (Goal $g) => $g->progress < $g->target)->sortBy(fn (Goal $g) => $g->due_at?->getTimestamp() ?? PHP_INT_MAX)->first();
    }

    /**
     * @template T of \Illuminate\Database\Eloquent\Model
     *
     * @param  class-string<T>  $model
     * @return T|null
     */
    private function resolve(string $model, User $user, ?int $id, string $message)
    {
        if ($id) {
            return $model::where('user_id', $user->id)->find($id);
        }

        return $message === '' ? null : $this->matchTitle($model::where('user_id', $user->id)->limit(200)->get(['id', 'title']), $message);
    }

    /**
     * The record whose title appears in the message (longest title wins, minimum 3 characters).
     *
     * @template T
     *
     * @param  Collection<int, T>  $records
     * @return T|null
     */
    private function matchTitle(Collection $records, string $message)
    {
        $text = mb_strtolower($message);

        return $records->sortByDesc(fn ($r) => mb_strlen($r->title))->first(fn ($r) => mb_strlen($r->title) >= 3 && str_contains($text, mb_strtolower($r->title)));
    }

    private function dueLabel(string $due, bool $completed, bool $ar): string
    {
        if ($completed) {
            return match ($due) {
                'today' => $ar ? 'اليوم' : 'today', 'tomorrow' => $ar ? 'غداً' : 'tomorrow', default => $ar ? 'خلال آخر ٧ أيام' : 'in the last 7 days',
            };
        }

        return match ($due) {
            'overdue' => $ar ? 'المتأخرة' : 'overdue',
            'today' => $ar ? 'المستحقة اليوم' : 'due today',
            'tomorrow' => $ar ? 'المستحقة غداً' : 'due tomorrow',
            'week' => $ar ? 'المستحقة خلال ٧ أيام' : 'due in the next 7 days',
            default => $ar ? 'بلا موعد' : 'without a deadline',
        };
    }

    /**
     * @param  list<string>  $reasons
     * @return array<string, mixed>
     */
    private function taskSummary(Task $task, array $reasons = []): array
    {
        return ['id' => $task->id, 'title' => $task->title, 'priority' => $task->priority, 'estimated_minutes' => $task->estimated_minutes, 'due_at' => $task->due_at?->toIso8601String(), 'reasons' => $reasons];
    }
}
