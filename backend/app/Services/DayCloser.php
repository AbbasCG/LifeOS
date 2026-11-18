<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * "Close the day": the evening ritual. A recap of the local day so far and one reviewable preview that rolls what is still open today to the next work
 * day. Deterministic and local (no AI provider, no outgoing request); the result is an ordinary AssistantProposal (kind 'close_day') made of existing
 * action types, so per-action approval, the conflict re-check on apply, the audit log and undo work as for every other proposal.
 *
 * What is open today, per open task (completed and cancelled tasks are ignored):
 * - a session today that has not ended (flexible, not copied to a connected calendar): move_event of that session (same row, same length);
 * - else a session today that ended without focus time on that task today, while the task has no other active session: create_event of the same
 *   length (the missed block stays as history, as in DayReorganizer);
 * - a deadline today: reschedule_task to the next work day (a date-only deadline stays date-only, a timed one keeps its local clock time), or to the
 *   day its session lands on when that is later.
 * New times are the first free slots of the next work days by FreeSlots (work and Ramadan hours, every calendar, breaks, prayer/iftar windows), most
 * urgent task first (BriefingService::rank); one proposal never books the same time twice. At most MAX_ACTIONS actions.
 */
class DayCloser
{
    public const KIND = 'close_day';

    public const MAX_ACTIONS = 12;

    /** Work days after today that may receive a session. */
    public const LOOKAHEAD_WORK_DAYS = 5;

    /** At most this many titles of tasks done today in the recap. */
    public const DONE_TITLES = 5;

    public function __construct(private PlanningService $planning, private FreeSlots $slots, private AssistantActions $actions, private GoalIntelligence $goals) {}

    /**
     * Compute the recap and the preview, and store the preview (the only write; none when nothing is open).
     *
     * @return array{proposal: AssistantProposal|null, summary: string, explanation: list<string>, recap: array<string, mixed>}
     */
    public function propose(User $user, bool $ar, string $provider = 'local'): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $t = fn (string $en, string $arabic) => $ar ? $arabic : $en;
        $recap = $this->recap($user, $now);
        $open = $this->openToday($user, $now);
        $focus = $this->hm($recap['focus_minutes'], $ar);
        if ($open->isEmpty()) {
            return ['proposal' => null, 'recap' => $recap, 'explanation' => [], 'summary' => $t(
                "Nothing is left open today. You finished {$recap['completed']} task(s) and focused {$focus}. Enjoy your evening.",
                "لم يبقَ شيء مفتوح اليوم. أنجزت {$recap['completed']} مهمة وركّزت {$focus}. استمتع بمسائك."
            )];
        }

        $ranked = BriefingService::rank($open->pluck('task'), $now, $this->goals->pressure($user));
        $position = array_flip($ranked->map(fn (array $row) => $row['task']->id)->all());
        $open = $open->sortBy(fn (array $o) => $position[$o['task']->id])->values();
        $days = $this->slots->days($user, $c, $now->startOfDay()->addDay(), self::LOOKAHEAD_WORK_DAYS, FreeSlots::earliest($now));
        $nextWorkDay = $days[0]['local'] ?? $now->startOfDay()->addDay();

        $actions = [];
        $unplaced = [];
        $deferred = [];
        foreach ($open as $item) {
            /** @var Task $task */
            $task = $item['task'];
            $need = ($item['session'] || $item['missed'] ? 1 : 0) + ($item['deadline'] ? 1 : 0);
            if (count($actions) + $need > self::MAX_ACTIONS) {
                $deferred[] = $task->title;

                continue;
            }
            $landed = null;
            if ($block = $item['session'] ?? $item['missed']) {
                $slot = $this->slots->take($days, (int) $block->starts_at->diffInSeconds($block->ends_at), $c['break']);
                if (! $slot) {
                    $unplaced[] = $task->title;
                } else {
                    $landed = $slot[2];
                    $when = $this->dayLabel($ar, $now, $slot[0]).($ar ? ' الساعة ' : ' at ').$slot[0]->setTimezone($c['tz'])->format('H:i');
                    $was = $block->starts_at->setTimezone($c['tz'])->format('H:i').'–'.$block->ends_at->setTimezone($c['tz'])->format('H:i');
                    $id = 'a'.(count($actions) + 1);
                    if ($item['session']) {
                        $reason = $t("Today’s session ({$was}) is still open, so it moves to {$when} with the same length.", "جلسة اليوم ({$was}) ما زالت مفتوحة، فتنتقل إلى {$when} بالمدة نفسها.");
                        $occurrence = ['event_id' => $block->id, 'title' => $block->title, 'starts_at' => $block->starts_at, 'ends_at' => $block->ends_at];
                        $actions[] = $this->actions->moveAction($user, $occurrence, $slot[0], $slot[1], $reason, $id) + ['task_id' => $task->id, 'source' => 'session'];
                    } else {
                        $reason = $t("You missed today’s session ({$was}); a new one of the same length is placed {$when}.", "فاتتك جلسة اليوم ({$was})؛ جلسة جديدة بالمدة نفسها {$when}.");
                        $actions[] = ['id' => $id, 'type' => 'create_event', 'title' => mb_substr($task->title, 0, 200), 'task_id' => $task->id,
                            'starts_at' => $slot[0]->utc()->toIso8601String(), 'ends_at' => $slot[1]->utc()->toIso8601String(), 'minutes' => (int) $slot[0]->diffInMinutes($slot[1]),
                            'source' => 'session', 'reason' => $reason];
                    }
                }
            }
            if ($item['deadline']) {
                $day = $landed && $landed > $nextWorkDay ? $landed : $nextWorkDay;
                $due = TaskPostponer::dueOn($task, $day, $c['tz']);
                $label = $this->dayLabel($ar, $now, $due);
                $reason = $task->due_all_day
                    ? $t("Due today and still open, so the deadline moves to {$label}.", "مستحقة اليوم وما زالت مفتوحة، فينتقل الموعد إلى {$label}.")
                    : $t("Due today at {$task->due_at->setTimezone($c['tz'])->format('H:i')} and still open, so the deadline moves to {$label} at the same time.", "مستحقة اليوم الساعة {$task->due_at->setTimezone($c['tz'])->format('H:i')} وما زالت مفتوحة، فينتقل الموعد إلى {$label} في الوقت نفسه.");
                $actions[] = ['id' => 'a'.(count($actions) + 1), 'type' => 'reschedule_task', 'task_id' => $task->id, 'title' => mb_substr($task->title, 0, 200),
                    'from_due_at' => $task->due_at->toIso8601String(), 'from_due_all_day' => (bool) $task->due_all_day, 'from_due_date' => $task->dueDate($c['tz']),
                    'due_at' => $due->toIso8601String(), 'due_all_day' => (bool) $task->due_all_day, 'due_date' => $task->due_all_day ? $due->setTimezone($c['tz'])->toDateString() : null,
                    'source' => 'deadline', 'reason' => $reason];
            }
        }

        $explanation = [$t("Today so far: {$recap['completed']} task(s) done, {$focus} of focus, {$this->hm($recap['planned_minutes'], false)} planned.", "اليوم حتى الآن: {$recap['completed']} مهمة منجزة، {$focus} تركيز، {$this->hm($recap['planned_minutes'], true)} مخطط.")];
        $explanation[] = $t('Still open today: '.$open->count().' task(s). Each one rolls to your next work day; nothing changes until you apply it.', 'ما زال مفتوحاً اليوم: '.$open->count().' مهام. تنتقل كل منها إلى يوم عملك التالي؛ لا يتغير شيء قبل أن تطبّقه.');
        if (collect($actions)->whereIn('type', ['move_event', 'create_event'])->isNotEmpty()) {
            $explanation[] = $t('Sessions go to the first free time of the next work day, around everything on your calendar (including connected calendars) and your breaks'.(($c['prayer'] instanceof PrayerTimes && $c['prayer']->enabled()) ? ', and prayer and iftar times' : '').'.',
                'تذهب الجلسات إلى أول وقت فارغ في يوم العمل التالي، حول كل ما في تقويمك (بما فيه التقاويم المرتبطة) واستراحاتك'.(($c['prayer'] instanceof PrayerTimes && $c['prayer']->enabled()) ? ' وأوقات الصلاة والإفطار' : '').'.');
        }
        if ($unplaced) {
            $explanation[] = $t('No room in the next '.self::LOOKAHEAD_WORK_DAYS.' work days for the session of: '.implode(', ', $unplaced).'.', 'لا يتسع الوقت خلال أيام العمل الخمسة القادمة لجلسة: '.implode('، ', $unplaced).'.');
        }
        if ($deferred) {
            $explanation[] = $t('Limit of '.self::MAX_ACTIONS.' changes reached; not handled yet: '.implode(', ', $deferred).'.', 'بلغت الحد الأقصى ('.self::MAX_ACTIONS.' تغييرات)؛ لم تُعالج بعد: '.implode('، ', $deferred).'.');
        }
        if ($actions === []) {
            return ['proposal' => null, 'recap' => $recap, 'explanation' => $explanation,
                'summary' => $t('Some work is still open today, but there is no room to roll it over in the next '.self::LOOKAHEAD_WORK_DAYS.' work days.', 'ما زال بعض العمل مفتوحاً اليوم، لكن لا يوجد متسع لنقله خلال أيام العمل الخمسة القادمة.')];
        }
        $summary = $t('Close the day: '.count($actions).' change(s) roll what is still open to your next work day. Review and choose what to apply.', 'إغلاق اليوم: '.count($actions).' تغييرات تنقل ما بقي مفتوحاً إلى يوم عملك التالي. راجعها واختر ما تطبّقه.');
        // A newer preview replaces an older one nobody applied, so two overlapping previews are never open together.
        AssistantProposal::where('user_id', $user->id)->where('kind', self::KIND)->where('status', 'pending')->update(['status' => 'dismissed']);
        $proposal = $this->actions->store($user, self::KIND, $provider, $summary, $explanation, $actions);

        return ['proposal' => $proposal, 'summary' => $summary, 'explanation' => $explanation, 'recap' => $recap];
    }

    /**
     * A cheap signal for the Today screen (a few queries, no planning run): how many tasks are still open today, and whether to suggest closing the
     * day (a work day, after the end of the work hours, Ramadan hours on a day of Ramadan, with something open).
     *
     * @return array{open_today: int, suggested: bool}
     */
    public function hint(User $user): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $day = $now->startOfDay();
        $open = $this->openToday($user, $now)->count();
        $after = false;
        if (in_array($day->dayOfWeek, $c['work_days'], true)) {
            $after = $now >= $day->setTimeFromTimeString($this->planning->workHours($c, $day)[1]);
        }

        return ['open_today' => $open, 'suggested' => $after && $open > 0];
    }

    /**
     * The local day so far: tasks completed, minutes of completed focus sessions (as the briefing counts them), minutes of task sessions planned
     * today (LifeOS sessions, clipped to the day) and the titles of the latest tasks done.
     *
     * @return array{completed: int, focus_minutes: int, planned_minutes: int, done_titles: list<string>}
     */
    public function recap(User $user, CarbonImmutable $now): array
    {
        $day = $now->startOfDay();
        $end = $day->addDay();
        $done = Task::where('user_id', $user->id)->where('status', 'completed')->whereBetween('completed_at', [$day->utc(), $end->utc()])->orderByDesc('completed_at')->orderByDesc('id');
        $focus = (int) floor(FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')->whereBetween('completed_at', [$day->utc(), $end->utc()])->sum('elapsed_seconds') / 60);
        $planned = CalendarEvent::where('user_id', $user->id)->whereNotNull('task_id')->whereNull('recurrence')->where('ends_at', '>', $day->utc())->where('starts_at', '<', $end->utc())->get(['starts_at', 'ends_at'])
            ->sum(fn (CalendarEvent $e) => (int) max($e->starts_at, $day)->diffInMinutes(min($e->ends_at, $end)));

        return ['completed' => (clone $done)->count(), 'focus_minutes' => $focus, 'planned_minutes' => (int) $planned, 'done_titles' => $done->limit(self::DONE_TITLES)->pluck('title')->all()];
    }

    /**
     * Open tasks that had something today, each with what rolls over: `session` (today's not-ended session to move), `missed` (today's ended
     * session to re-place) and `deadline` (due today).
     *
     * @return Collection<int, array{task: Task, session: ?CalendarEvent, missed: ?CalendarEvent, deadline: bool}>
     */
    private function openToday(User $user, CarbonImmutable $now): Collection
    {
        $day = $now->startOfDay();
        $end = $day->addDay();
        $events = CalendarEvent::where('user_id', $user->id)->whereNotNull('task_id')->whereNull('recurrence')
            ->where('starts_at', '>=', $day->utc())->where('starts_at', '<', $end->utc())->orderBy('starts_at')->orderBy('id')->get()->groupBy('task_id');
        $tasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])
            ->where(fn ($q) => $q->whereIn('id', $events->keys()->all())->orWhere(fn ($q) => $q->where('due_at', '>=', $day->utc())->where('due_at', '<', $end->utc())))
            ->orderBy('id')->limit(200)->get();
        if ($tasks->isEmpty()) {
            return collect();
        }
        $ids = $tasks->pluck('id');
        $active = app(TaskScheduler::class)->activeSessions($user->id, $ids);
        $focused = FocusSession::where('user_id', $user->id)->whereIn('task_id', $ids->all())->where('status', 'completed')->whereBetween('completed_at', [$day->utc(), $end->utc()])->pluck('task_id')->flip();
        $linked = CalendarWriteLink::where('user_id', $user->id)->whereIn('calendar_event_id', $events->flatten()->pluck('id')->all())->pluck('calendar_event_id')->flip();

        return $tasks->map(function (Task $task) use ($events, $active, $focused, $linked, $now, $day, $end) {
            $today = $events->get($task->id, collect());
            $upcoming = $today->first(fn (CalendarEvent $e) => $e->ends_at > $now);
            $session = $upcoming && $upcoming->kind !== 'fixed' && ! $linked->has($upcoming->id) ? $upcoming : null;
            $missed = null;
            if (! $upcoming && ! $focused->has($task->id) && $active->get($task->id, collect())->isEmpty()) {
                $missed = $today->filter(fn (CalendarEvent $e) => $e->kind === 'flexible' && $e->ends_at <= $now)->last();
            }
            $deadline = $task->due_at !== null && $task->due_at >= $day && $task->due_at < $end;

            return ['task' => $task, 'session' => $session, 'missed' => $missed, 'deadline' => $deadline];
        })->filter(fn (array $o) => $o['session'] || $o['missed'] || $o['deadline'])->values();
    }

    private function dayLabel(bool $ar, CarbonImmutable $now, CarbonImmutable $at): string
    {
        $local = $at->setTimezone($now->getTimezone());
        if ($local->isSameDay($now->addDay())) {
            return $ar ? 'غداً' : 'tomorrow';
        }

        return $local->locale($ar ? 'ar' : 'en')->translatedFormat('l j F');
    }

    private function hm(int $minutes, bool $ar): string
    {
        $h = intdiv($minutes, 60);
        $m = $minutes % 60;

        return $ar ? trim(($h ? "{$h} س " : '').($m || ! $h ? "{$m} د" : '')) : trim(($h ? "{$h}h " : '').($m || ! $h ? "{$m}m" : ''));
    }
}
