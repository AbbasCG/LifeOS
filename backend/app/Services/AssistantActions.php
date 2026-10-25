<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\Category;
use App\Models\FocusSession;
use App\Models\Goal;
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
    public const ACTION_TYPES = ['create_event', 'move_event', 'create_task', 'reschedule_task'];

    public const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

    public const TTL_HOURS = 24;

    public const MAX_BLOCK_MINUTES = 480;

    /** Existing events one proposal may move. */
    public const MAX_MOVES = 10;

    public function __construct(private CalendarService $calendar, private PlanningService $planning, private AuditLogger $audit, private GoalIntelligence $goals) {}

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
        $plan = $this->rebalanceMoves($user, CarbonImmutable::now($c['tz'])->startOfDay(), 7, $ar);
        $summaryText = match (true) {
            $plan['overloaded'] === 0 => $ar ? 'لا يوجد يوم مزدحم خلال الأيام السبعة القادمة. توزيعك متوازن.' : 'No day in the next seven is overloaded. Your week looks balanced.',
            $plan['actions'] === [] => $ar ? 'هناك أيام مزدحمة، لكن لا توجد فترات مرنة يمكن نقلها تلقائياً. فكّر في تقصير أو إلغاء بعض الالتزامات.' : 'Some days are overloaded, but there are no flexible blocks I can move safely. Consider shortening or dropping something.',
            default => $ar ? 'أقترح نقل '.count($plan['actions']).' فترة مرنة لتخفيف الأيام المزدحمة. الالتزامات الثابتة والمتكررة والخارجية لن تتغير.' : 'I suggest moving '.count($plan['actions']).' flexible block(s) to lighten overloaded days. Fixed, recurring and external events stay where they are.',
        };

        return $this->store($user, 'rebalance', $provider, $summaryText, $plan['explanation'], $plan['actions']);
    }

    /**
     * Moves that take flexible blocks off overloaded days (above 80% of capacity) to the lightest work days in range.
     * Nothing is saved: the moves become actions of a proposal.
     *
     * @param  list<array{0: CarbonImmutable, 1: CarbonImmutable}>  $reserved  time other proposed changes will use
     * @return array{actions: list<array<string, mixed>>, explanation: list<string>, overloaded: int}
     */
    public function rebalanceMoves(User $user, CarbonImmutable $first, int $days, bool $ar, array $reserved = []): array
    {
        $c = $this->planning->config($user);
        $summary = $this->planning->summary($user, $first, $days, [], [], $c);
        $dayList = collect($summary['days']);
        $overloaded = $dayList->where('overloaded', true)->values();
        $actions = [];
        $explanation = [];
        $occurrences = $this->calendar->occurrences($user, $first->utc(), $first->addDays($days)->utc());
        $movable = $this->movable($user, $occurrences);
        $busy = array_merge($occurrences->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all(), $reserved);
        $now = CarbonImmutable::now();
        foreach ($overloaded as $day) {
            if (count($actions) >= self::MAX_MOVES) {
                break;
            }
            $explanation[] = $ar ? "يوم {$day['date']} محجوز بنسبة {$day['load_percent']}٪ من ساعات عملك." : "{$day['date']} is {$day['load_percent']}% booked against your working hours.";
            $local = CarbonImmutable::parse($day['date'], $c['tz']);
            $candidates = $movable->filter(fn (array $o) => $o['starts_at'] >= $local->utc() && $o['starts_at'] < $local->addDay()->utc())
                ->sortByDesc(fn (array $o) => $o['starts_at']->diffInMinutes($o['ends_at']));
            $excess = (int) ceil(($day['load_percent'] - 80) / 100 * max(1, $day['capacity_minutes']));
            foreach ($candidates as $occurrence) {
                if ($excess <= 0 || count($actions) >= self::MAX_MOVES) {
                    break;
                }
                $minutes = (int) $occurrence['starts_at']->diffInMinutes($occurrence['ends_at']);
                foreach ($dayList->where('work_day', true)->where('overloaded', false)->sortBy('load_percent') as $target) {
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
                    $reason = $ar ? "«{$occurrence['title']}» مرنة، ويوم {$target['date']} أخف ({$target['load_percent']}٪)." : "“{$occurrence['title']}” is flexible, and {$target['date']} is lighter ({$target['load_percent']}%).";
                    $actions[] = $this->moveAction($user, $occurrence, $slot[0], $slot[1], $reason, 'a'.(count($actions) + 1));
                    $explanation[] = $reason;
                    $excess -= $minutes;
                    break;
                }
            }
        }

        return ['actions' => $actions, 'explanation' => $explanation, 'overloaded' => $overloaded->count()];
    }

    /**
     * Occurrences a plan may move: the user's own flexible, non-recurring LifeOS events that start in the future and
     * were never copied to a connected calendar. Fixed appointments, recurring series and imported events never move.
     *
     * @param  Collection<int, array<string, mixed>>  $occurrences
     * @return Collection<int, array<string, mixed>>
     */
    public function movable(User $user, Collection $occurrences): Collection
    {
        $linked = CalendarWriteLink::where('user_id', $user->id)->whereNotNull('calendar_event_id')->pluck('calendar_event_id')->flip();
        $soon = CarbonImmutable::now()->addMinutes(5);

        return $occurrences->filter(fn (array $o) => ($o['source'] ?? 'lifeos') === 'lifeos' && ! empty($o['event_id']) && ! ($o['recurring'] ?? false)
            && $o['kind'] !== 'fixed' && $o['starts_at'] > $soon && ! $linked->has($o['event_id']))->values();
    }

    /**
     * A move_event action with the same conflict preview the timeline shows before a manual move (checked now, and
     * again when the user applies it).
     *
     * @param  array<string, mixed>  $occurrence
     * @return array<string, mixed>
     */
    public function moveAction(User $user, array $occurrence, CarbonImmutable $start, CarbonImmutable $end, string $reason, string $id): array
    {
        $event = CalendarEvent::where('user_id', $user->id)->find($occurrence['event_id']);
        $preview = $event ? app(TimelineService::class)->preview($user, $event, null, $start->utc(), $end->utc()) : ['conflicts' => []];

        return [
            'id' => $id, 'type' => 'move_event', 'event_id' => $occurrence['event_id'], 'title' => mb_substr($occurrence['title'], 0, 200),
            'from_starts_at' => $occurrence['starts_at']->utc()->toIso8601String(), 'from_ends_at' => $occurrence['ends_at']->utc()->toIso8601String(),
            'starts_at' => $start->utc()->toIso8601String(), 'ends_at' => $end->utc()->toIso8601String(), 'minutes' => (int) $start->diffInMinutes($end),
            'reason' => $reason, 'conflicts' => array_map(fn (array $c) => array_intersect_key($c, array_flip(['title', 'source_label', 'starts_at', 'ends_at', 'minutes'])), $preview['conflicts']),
        ];
    }

    /**
     * Turn a goal into concrete, dated tasks: steps from the provider, the goal's unfinished milestones, or a short
     * template. Due dates are spread between now and the goal deadline (weekly when there is none).
     *
     * @param  list<array{title: string, estimated_minutes?: int|null}>  $steps
     */
    public function proposeGoalPlan(User $user, Goal $goal, array $steps, bool $ar, string $provider): AssistantProposal
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $health = $this->goals->goals($user)->firstWhere('id', $goal->id);
        $explanation = collect($health['reasons'] ?? [])->map(fn (array $r) => $r[$ar ? 'ar' : 'en'])->all();
        $existing = Task::where('user_id', $user->id)->where('goal_id', $goal->id)->whereNotIn('status', ['completed', 'cancelled'])->pluck('title')->map(fn (string $t) => mb_strtolower($t))->all();

        if ($steps !== []) {
            $explanation[] = $ar ? 'الخطوات مقترحة من مزود الذكاء الاصطناعي، وتحققت منها وحددت مواعيدها من بياناتك.' : 'Steps were suggested by the AI provider; dates and checks come from your own data.';
        } elseif (! empty($health['suggested_tasks']) && count($health['suggested_tasks']) > 0) {
            $steps = collect($health['suggested_tasks'])->map(fn (array $m) => ['title' => $m['title'], 'estimated_minutes' => 60])->all();
            $explanation[] = $ar ? 'حوّلت المعالم غير المنجزة لهذا الهدف إلى مهام.' : 'Turned this goal’s unfinished milestones into tasks.';
        } else {
            $steps = $ar
                ? [['title' => "حدّد المعلم القابل للقياس التالي لـ «{$goal->title}»", 'estimated_minutes' => 30], ['title' => "أنجز أول خطوة عملية نحو «{$goal->title}»", 'estimated_minutes' => 90], ['title' => "راجع التقدم في «{$goal->title}» وعدّل الخطة", 'estimated_minutes' => 30]]
                : [['title' => "Define the next measurable milestone for “{$goal->title}”", 'estimated_minutes' => 30], ['title' => "Do the first concrete step toward “{$goal->title}”", 'estimated_minutes' => 90], ['title' => "Review progress on “{$goal->title}” and adjust the plan", 'estimated_minutes' => 30]];
            $explanation[] = $ar ? 'لا توجد معالم لهذا الهدف، فاقترحت خطوات عامة. أضف معالم للهدف لاقتراحات أدق.' : 'This goal has no milestones, so these are general steps. Add milestones to the goal for sharper suggestions.';
        }
        $steps = collect($steps)->map(fn (array $s) => ['title' => trim(mb_substr((string) $s['title'], 0, 200)), 'estimated_minutes' => (int) max(5, min(480, $s['estimated_minutes'] ?? 60))])
            ->filter(fn (array $s) => $s['title'] !== '' && ! in_array(mb_strtolower($s['title']), $existing, true))->unique('title')->take(8)->values();

        $deadline = $goal->due_at && $goal->due_at->isAfter($now->addDays(2)) ? CarbonImmutable::instance($goal->due_at)->setTimezone($c['tz']) : null;
        $span = $deadline ? max(1, (int) floor($now->diffInDays($deadline) / max(1, $steps->count()))) : 7;
        $priority = in_array($health['status'] ?? null, ['at_risk', 'behind', 'overdue'], true) ? 'high' : 'medium';
        $actions = $steps->map(fn (array $s, int $i) => [
            'id' => 'a'.($i + 1), 'type' => 'create_task', 'title' => $s['title'], 'goal_id' => $goal->id, 'priority' => $priority,
            'estimated_minutes' => $s['estimated_minutes'], 'minutes' => $s['estimated_minutes'],
            'due_at' => min($deadline ?? $now->addYear(), $now->startOfDay()->addDays(($i + 1) * $span)->setTimeFromTimeString($c['work_end']))->utc()->toIso8601String(),
        ])->all();
        $explanation[] = $deadline
            ? ($ar ? "وزّعت المواعيد بالتساوي حتى موعد الهدف ({$deadline->toDateString()})." : "Spread due dates evenly up to the goal deadline ({$deadline->toDateString()}).")
            : ($ar ? 'لا يوجد موعد قريب للهدف، فجعلت المواعيد أسبوعية.' : 'The goal has no upcoming deadline, so steps are a week apart.');
        if ($priority === 'high') {
            $explanation[] = $ar ? 'أولوية عالية لأن الهدف يحتاج اهتماماً.' : 'High priority because the goal needs attention.';
        }
        $summary = $actions === []
            ? ($ar ? "كل الخطوات المقترحة لـ «{$goal->title}» موجودة بالفعل كمهام." : "Every suggested step for “{$goal->title}” already exists as a task.")
            : ($ar ? 'خطة لـ «'.$goal->title.'»: '.count($actions).' مهام مؤرخة. راجعها واختر ما تريد إنشاءه.' : 'Plan for “'.$goal->title.'”: '.count($actions).' dated task(s). Review and choose which to create.');

        return $this->store($user, 'goal_plan', $provider, $summary, $explanation, $actions);
    }

    /**
     * Give overdue tasks realistic new deadlines on the next work days that still have free time for them.
     */
    public function proposeTriage(User $user, bool $ar, string $provider): AssistantProposal
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $overdue = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->where('due_at', '<', now())->limit(100)->get();
        $ranked = BriefingService::rank($overdue, $now, $this->goals->pressure($user))->take(8)->values();
        $days = collect($this->planning->summary($user, $now->startOfDay(), 10, [], [], $c)['days'])->where('work_day', true)->values()->all();
        $actions = [];
        $explanation = [];
        $unplaced = [];
        foreach ($ranked as $row) {
            $task = $row['task'];
            $need = max(15, $task->estimated_minutes - (int) $task->actual_minutes);
            $placed = false;
            foreach ($days as $i => $day) {
                $end = CarbonImmutable::parse($day['date'], $c['tz'])->setTimeFromTimeString($c['work_end']);
                if ($end <= $now->addMinutes(30) || $day['free_minutes'] < $need) {
                    continue;
                }
                $days[$i]['free_minutes'] -= $need;
                $actions[] = ['id' => 'a'.(count($actions) + 1), 'type' => 'reschedule_task', 'task_id' => $task->id, 'title' => $task->title, 'from_due_at' => $task->due_at->toIso8601String(), 'due_at' => $end->utc()->toIso8601String(), 'minutes' => $need];
                $placed = true;
                break;
            }
            if (! $placed) {
                $unplaced[] = $task->title;
            }
        }
        if ($actions !== []) {
            $explanation[] = $ar ? 'رتّبت المهام المتأخرة حسب الأولوية، وأعطيت كلاً منها أقرب يوم عمل فيه وقت فارغ يكفي لما تبقى منها.' : 'Ordered overdue tasks by priority and gave each the first work day with enough free time for the remaining work.';
            $explanation[] = $ar ? 'الموعد الجديد هو نهاية ساعات العمل في ذلك اليوم.' : 'The new deadline is the end of your working hours that day.';
        }
        if ($unplaced) {
            $explanation[] = $ar ? 'لا يتسع الوقت خلال الأيام العشرة القادمة لـ: '.implode('، ', $unplaced).'. فكّر في تقسيمها أو إلغائها.' : 'No room in the next 10 days for: '.implode(', ', $unplaced).'. Consider splitting or dropping them.';
        }
        $summary = match (true) {
            $overdue->isEmpty() => $ar ? 'لا توجد مهام متأخرة لإعادة جدولتها.' : 'Nothing is overdue, so there is nothing to reschedule.',
            $actions === [] => $ar ? 'لا يوجد وقت فارغ كافٍ لإعادة جدولة المهام المتأخرة خلال الأيام القادمة.' : 'There isn’t enough free time in the coming days to reschedule your overdue tasks.',
            default => $ar ? 'أقترح مواعيد جديدة لـ '.count($actions).' مهمة متأخرة. راجعها واختر ما تريد تطبيقه.' : 'I suggest new deadlines for '.count($actions).' overdue task(s). Review and choose which to apply.',
        };

        return $this->store($user, 'triage', $provider, $summary, $explanation, $actions);
    }

    /**
     * Find time for specific open tasks (e.g. study tasks) in the next seven days: each task gets a block inside its
     * life-area window, around everything already on the calendar — LifeOS and connected calendars alike — and before
     * its deadline. Produces create_event actions; connected calendars are never written to.
     *
     * @param  Collection<int, Task>  $tasks
     */
    public function proposeFindTime(User $user, Collection $tasks, string $label, bool $ar, string $provider): AssistantProposal
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $areas = Category::where('user_id', $user->id)->pluck('area', 'id');
        $occurrences = $this->calendar->occurrences($user, $now->utc(), $now->startOfDay()->addDays(7)->utc());
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();
        $connected = $occurrences->where('source', '!=', 'lifeos')->groupBy('source')->map->count();
        $actions = [];
        $explanation = [];
        $unplaced = [];
        foreach ($tasks->take(6) as $task) {
            $area = $areas[$task->category_id] ?? 'work';
            $minutes = (int) max(30, min(120, $task->estimated_minutes - (int) $task->actual_minutes));
            $placed = false;
            for ($d = 0; $d < 7 && ! $placed; $d++) {
                $day = $now->startOfDay()->addDays($d);
                $window = $this->planning->windows($c, $day)[$area] ?? null;
                if (! $window) {
                    continue;
                }
                $start = max($window[0], $now->addMinutes(15 - $now->minute % 15)->startOfMinute());
                if ($start >= $window[1]) {
                    continue;
                }
                $free = $this->planning->freeIntervals($start->utc(), $window[1]->utc(), $busy, $c['break']);
                $slot = $this->takeSlot($free, $minutes, $c['break']);
                if (! $slot && collect($free)->contains(fn ($f) => $f[0]->diffInMinutes($f[1]) >= 30)) {
                    $minutes = (int) (floor(collect($free)->map(fn ($f) => $f[0]->diffInMinutes($f[1]))->max() / 5) * 5);
                    $slot = $this->takeSlot($free, $minutes, $c['break']);
                }
                if (! $slot || ($task->due_at && $slot[1] > $task->due_at)) {
                    continue;
                }
                $busy[] = $slot;
                $actions[] = ['id' => 'a'.(count($actions) + 1), 'type' => 'create_event', 'title' => $task->title, 'task_id' => $task->id,
                    'starts_at' => $slot[0]->toIso8601String(), 'ends_at' => $slot[1]->toIso8601String(), 'minutes' => $minutes];
                $placed = true;
            }
            if (! $placed) {
                $unplaced[] = $task->title;
            }
        }
        $sources = $connected->map(fn ($n, $s) => $n.' '.(['google' => 'Google', 'outlook' => 'Outlook', 'ics' => 'subscribed'][$s] ?? $s))->implode($ar ? '، ' : ', ');
        $explanation[] = $ar
            ? 'تجنّبت '.$occurrences->count().' التزاماً خلال الأسبوع'.($sources ? " (منها {$sources} من التقويمات المرتبطة)" : '').'.'
            : 'Worked around '.$occurrences->count().' commitment(s) this week'.($sources ? " (including {$sources} from connected calendars)" : '').'.';
        $explanation[] = $ar ? 'وُضعت كل مهمة ضمن نافذة مجالها (العمل أو الدراسة أو الشخصي) وقبل موعدها النهائي.' : 'Each task sits inside its life-area window (work, study or personal) and before its deadline.';
        if ($unplaced) {
            $explanation[] = $ar ? 'لم أجد وقتاً لـ: '.implode('، ', $unplaced).'.' : 'No room found for: '.implode(', ', $unplaced).'.';
        }
        $summary = $actions === []
            ? ($ar ? "لم أجد وقتاً فارغاً لـ{$label} خلال الأيام السبعة القادمة." : "I couldn’t find free time for {$label} in the next 7 days.")
            : ($ar ? 'اقتراح: '.count($actions)." فترات لـ{$label} حول التزاماتك. راجعها قبل إضافتها." : 'Suggested '.count($actions)." block(s) for {$label} around your commitments. Review before adding them.");

        return $this->store($user, 'find_time', $provider, $summary, $explanation, $actions);
    }

    /**
     * New LifeOS calendar blocks computed by a planner (Copilot plans) as one proposal: the same preview, partial
     * approval, re-validation at apply time and undo as every other proposal. Never writes to connected calendars.
     *
     * Moves (from moveAction) come first. Each action stands on its own: new blocks avoid where moved events will go and
     * never reuse the time a move frees, so any subset can be approved.
     *
     * @param  list<array{title: string, task_id: int|null, starts_at: CarbonImmutable, ends_at: CarbonImmutable}>  $blocks
     * @param  list<string>  $explanation
     * @param  list<array<string, mixed>>  $moves
     */
    public function proposeBlocks(User $user, string $kind, string $provider, string $summary, array $explanation, array $blocks, array $moves = []): AssistantProposal
    {
        $creates = array_map(fn (array $b) => ['type' => 'create_event', 'title' => mb_substr($b['title'], 0, 200), 'task_id' => $b['task_id'],
            'starts_at' => $b['starts_at']->utc()->toIso8601String(), 'ends_at' => $b['ends_at']->utc()->toIso8601String(), 'minutes' => (int) $b['starts_at']->diffInMinutes($b['ends_at'])], $blocks);
        $all = array_merge(array_slice($moves, 0, self::MAX_MOVES), $creates);
        $actions = array_values(array_map(fn (array $a, int $i) => ['id' => 'a'.($i + 1)] + $a, $all, array_keys($all)));

        return $this->store($user, $kind, $provider, $summary, $explanation, $actions);
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

    /**
     * Reverse an applied proposal within UNDO_HOURS. Each change is reversed only if it is still exactly as the
     * assistant left it; anything the user has touched since is kept and reported, never overwritten.
     */
    public function undo(User $user, AssistantProposal $proposal, ?Request $request = null): AssistantProposal
    {
        if (! $proposal->canUndo()) {
            throw ValidationException::withMessages(['proposal' => [$proposal->status === 'undone' ? 'These changes were already undone.' : 'These changes can no longer be undone.']]);
        }
        $results = DB::transaction(function () use ($user, $proposal) {
            $locked = AssistantProposal::whereKey($proposal->id)->lockForUpdate()->first();
            if (! $locked->canUndo()) {
                throw ValidationException::withMessages(['proposal' => ['These changes were already undone.']]);
            }
            // Newest change first, so a block created for a new task is removed before the task itself.
            $results = array_reverse(array_map(fn (array $result) => $result + ['undo' => $this->reverse($user, $result)], array_reverse($locked->results ?? [])));
            $locked->update(['status' => 'undone', 'results' => $results]);

            return $results;
        });
        $reversed = collect($results)->where('undo.done', true)->count();
        $this->audit->log($user, 'ai_action_undone', $request, ['proposal' => $proposal->id, 'kind' => $proposal->kind, 'reversed' => $reversed, 'kept' => count($results) - $reversed]);

        return $proposal->fresh();
    }

    /**
     * @param  array<string, mixed>  $result
     * @return array{done: bool, reason?: string}
     */
    private function reverse(User $user, array $result): array
    {
        $kept = fn (string $reason) => ['done' => false, 'reason' => $reason];
        switch ($result['type'] ?? null) {
            case 'create_event':
            case 'move_event':
                $event = CalendarEvent::where('user_id', $user->id)->whereKey($result['event_id'] ?? 0)->lockForUpdate()->first();
                if (! $event) {
                    return $kept('already deleted');
                }
                if (! isset($result['after']) || $this->eventState($event) !== $result['after']) {
                    return $kept('changed since');
                }
                if ($result['type'] === 'create_event') {
                    $event->delete();

                    return ['done' => true];
                }
                $from = CarbonImmutable::parse($result['before']['starts_at']);
                $to = CarbonImmutable::parse($result['before']['ends_at']);
                if ($this->calendar->conflicts($user, $from, $to, $event->id)->isNotEmpty()) {
                    return $kept('original time is taken');
                }
                $event->update(['starts_at' => $from, 'ends_at' => $to]);

                return ['done' => true];
            case 'create_task':
                $task = Task::where('user_id', $user->id)->whereKey($result['task_id'] ?? 0)->lockForUpdate()->first();
                if (! $task) {
                    return $kept('already deleted');
                }
                $untouched = isset($result['after']) && $task->title === $result['after']['title'] && $task->due_at?->toIso8601String() === $result['after']['due_at']
                    && $task->status === 'todo' && (int) $task->actual_minutes === 0 && ! CalendarEvent::where('task_id', $task->id)->exists() && ! FocusSession::where('task_id', $task->id)->exists();

                if (! $untouched) {
                    return $kept('in use since');
                }
                $task->delete();

                return ['done' => true];
            case 'reschedule_task':
                $task = Task::where('user_id', $user->id)->whereKey($result['task_id'] ?? 0)->lockForUpdate()->first();
                if (! $task || ! isset($result['before']) || $task->due_at?->toIso8601String() !== $result['after']['due_at']) {
                    return $kept('changed since');
                }
                $task->update(['due_at' => CarbonImmutable::parse($result['before']['due_at'])]);

                return ['done' => true];
        }

        return $kept('not reversible');
    }

    /**
     * @return array{title: string, starts_at: string, ends_at: string}
     */
    private function eventState(CalendarEvent $event): array
    {
        return ['title' => $event->title, 'starts_at' => $event->starts_at->utc()->toIso8601String(), 'ends_at' => $event->ends_at->utc()->toIso8601String()];
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
        if (in_array($action['type'], ['create_task', 'reschedule_task'], true)) {
            return $this->executeTask($user, $action, $fail);
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

            return ['action_id' => $action['id'], 'type' => 'create_event', 'event_id' => $event->id, 'after' => $this->eventState($event)];
        }

        $event = CalendarEvent::where('user_id', $user->id)->whereKey($action['event_id'])->whereNull('recurrence')->lockForUpdate()->first();
        if (! $event || $event->kind === 'fixed') {
            $fail('This event can no longer be moved.');
        }
        if (CalendarWriteLink::where('user_id', $user->id)->where('calendar_event_id', $event->id)->exists()) {
            $fail('This event was copied to a connected calendar, so it is not moved from here.');
        }
        if (! $event->starts_at->equalTo(CarbonImmutable::parse($action['from_starts_at']))) {
            $fail('This event changed since the suggestion was made.');
        }
        $this->assertFree($user, $start, $end, $event->id, $fail);
        $before = $this->eventState($event);
        $event->update(['starts_at' => $start, 'ends_at' => $end]);

        return ['action_id' => $action['id'], 'type' => 'move_event', 'event_id' => $event->id, 'before' => $before, 'after' => $this->eventState($event)];
    }

    /**
     * Task actions are re-validated against current data: ownership, open status, unchanged deadline, sane values.
     *
     * @param  array<string, mixed>  $action
     * @return array<string, mixed>
     */
    private function executeTask(User $user, array $action, callable $fail): array
    {
        $due = isset($action['due_at']) ? CarbonImmutable::parse($action['due_at'])->utc() : null;
        if ($due && $due < now()->subMinutes(5)) {
            $fail('This deadline is already in the past.');
        }

        if ($action['type'] === 'create_task') {
            $title = trim(mb_substr((string) ($action['title'] ?? ''), 0, 200));
            $minutes = (int) ($action['estimated_minutes'] ?? 0);
            if ($title === '' || $minutes < 5 || $minutes > self::MAX_BLOCK_MINUTES || ! in_array($action['priority'] ?? null, self::PRIORITIES, true)) {
                $fail('This task suggestion is not valid.');
            }
            $goalId = $action['goal_id'] ?? null;
            if ($goalId && ! Goal::where('user_id', $user->id)->whereKey($goalId)->exists()) {
                $fail('The goal no longer exists.');
            }
            if (Task::where('user_id', $user->id)->where('goal_id', $goalId)->whereNotIn('status', ['completed', 'cancelled'])->whereRaw('lower(title) = ?', [mb_strtolower($title)])->exists()) {
                $fail('A task with this title already exists for the goal.');
            }
            $task = Task::create(['user_id' => $user->id, 'goal_id' => $goalId, 'title' => $title, 'priority' => $action['priority'], 'estimated_minutes' => $minutes, 'due_at' => $due, 'status' => 'todo']);

            return ['action_id' => $action['id'], 'type' => 'create_task', 'task_id' => $task->id, 'after' => ['title' => $task->title, 'due_at' => $task->due_at?->toIso8601String()]];
        }

        $task = Task::where('user_id', $user->id)->whereKey($action['task_id'] ?? 0)->lockForUpdate()->first();
        if (! $task || in_array($task->status, ['completed', 'cancelled'], true)) {
            $fail('This task is no longer open.');
        }
        $from = isset($action['from_due_at']) ? CarbonImmutable::parse($action['from_due_at']) : null;
        if (! $due || ! $from || ! $task->due_at?->equalTo($from)) {
            $fail('This task changed since the suggestion was made.');
        }
        $before = ['due_at' => $task->due_at->toIso8601String()];
        $task->update(['due_at' => $due]);

        return ['action_id' => $action['id'], 'type' => 'reschedule_task', 'task_id' => $task->id, 'before' => $before, 'after' => ['due_at' => $due->toIso8601String()]];
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
