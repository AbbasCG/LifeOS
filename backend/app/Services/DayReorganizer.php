<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * "Reorganize my day": when the day slips, builds one reviewable preview that re-places missed and unscheduled work.
 *
 * Deterministic and local: no AI provider is called and no task text leaves the app. The result is an ordinary
 * AssistantProposal (kind 'reorganize') made of existing action types (create_event, move_event), so per-action
 * approval, the conflict re-check on apply, the audit log and undo all work as they do for every other proposal.
 * Each action stands on its own (new sessions never use time that a proposed move frees), so any subset can be applied.
 */
class DayReorganizer
{
    public const KIND = 'reorganize';

    /** Actions one proposal may hold. */
    public const MAX_ACTIONS = 12;

    /** Work days after today that may receive a session. */
    public const LOOKAHEAD_WORK_DAYS = 5;

    /** An open proposal younger than this that still matches is returned instead of creating another. */
    public const REUSE_MINUTES = 10;

    /** A new session for work that was never scheduled is at most this long (the rest is planned later). */
    public const MAX_SESSION_MINUTES = 120;

    /** On a low-energy day (check-in 1-2) a new session is at most this long. */
    public const LOW_ENERGY_SESSION_MINUTES = 45;

    /** Past this share of today's remaining capacity the day counts as overloaded, as in PlanningService::summary. */
    public const OVERLOAD_PERCENT = 90;

    /** Overflow moves bring the day back under this share. */
    public const TARGET_PERCENT = 80;

    public function __construct(private PlanningService $planning, private CalendarService $calendar, private TaskScheduler $scheduler, private AssistantActions $actions, private CheckinService $checkins, private GoalIntelligence $goals) {}

    /**
     * Compute the preview and store it. Writes only the proposal row, and none when there is nothing to do.
     *
     * @return array{proposal: AssistantProposal|null, summary: string, explanation: list<string>}
     */
    public function propose(User $user, bool $ar, string $provider = 'local'): array
    {
        $plan = $this->plan($user, $ar);
        if ($plan['actions'] === []) {
            return ['proposal' => null, 'summary' => $plan['summary'], 'explanation' => $plan['explanation']];
        }
        $existing = $this->reusable($user, $plan['actions']);
        if ($existing) {
            return ['proposal' => $existing, 'summary' => $existing->summary, 'explanation' => $existing->explanation];
        }
        // A newer preview replaces an older one that nobody applied, so two overlapping previews are never open together.
        AssistantProposal::where('user_id', $user->id)->where('kind', self::KIND)->where('status', 'pending')->update(['status' => 'dismissed']);
        $proposal = $this->actions->store($user, self::KIND, $provider, $plan['summary'], $plan['explanation'], $plan['actions']);

        return ['proposal' => $proposal, 'summary' => $plan['summary'], 'explanation' => $plan['explanation']];
    }

    /**
     * A cheap signal for the Today screen (a few queries, no planning run).
     *
     * @param  Collection<int, array<string, mixed>>|null  $occurrences  today's calendar when the caller already has it
     * @return array{missed: int, due_unscheduled: int, overloaded: bool}
     */
    public function hint(User $user, ?Collection $occurrences = null): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $end = $now->startOfDay()->addDay();
        $missed = $this->missedToday($user, $now, $end);
        $missedTaskIds = $missed->pluck('task_id')->unique();
        $stillMissed = $missedTaskIds->isEmpty() ? collect() : $missedTaskIds->diff($this->scheduler->activeSessions($user->id, $missedTaskIds)->keys())->unique();

        $due = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->where('due_at', '<', $end->utc())
            ->whereNotExists(fn ($q) => $q->selectRaw('1')->from('calendar_events')->whereColumn('calendar_events.task_id', 'tasks.id')->whereNull('calendar_events.recurrence')->where('calendar_events.ends_at', '>', now()))
            ->limit(100)->get(['id', 'estimated_minutes', 'actual_minutes'])->reject(fn (Task $t) => $stillMissed->contains($t->id));

        $need = (int) $missed->whereIn('task_id', $stillMissed->all())->sum('minutes') + (int) $due->sum(fn (Task $t) => max(15, min(self::MAX_SESSION_MINUTES, $t->estimated_minutes - (int) $t->actual_minutes)));
        $overloaded = false;
        if ($window = $this->remainingWindow($c, $now)) {
            $occurrences ??= $this->calendar->occurrences($user, $now->startOfDay()->utc(), $end->utc());
            $closed = $this->calendar->closedTaskIds($user, $occurrences);
            $capacity = $this->capacity($c, $window);
            $booked = (int) $occurrences->reject(fn (array $o) => isset($o['task_id']) && $closed->has($o['task_id']))
                ->sum(fn (array $o) => max(0, (int) max($o['starts_at'], $window[0])->diffInMinutes(min($o['ends_at'], $window[1]), false)));
            $overloaded = $capacity > 0 && ($booked + $need) / $capacity * 100 >= self::OVERLOAD_PERCENT;
        }

        return ['missed' => $stillMissed->count(), 'due_unscheduled' => $due->count(), 'overloaded' => $overloaded];
    }

    /**
     * The whole computation, without storing anything.
     *
     * @return array{actions: list<array<string, mixed>>, summary: string, explanation: list<string>}
     */
    public function plan(User $user, bool $ar): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $today = $now->startOfDay();
        $end = $today->addDay();
        $t = fn (string $en, string $arabic) => $ar ? $arabic : $en;
        $explanation = [];

        // 1. What slipped: today's missed sessions and open work due today or already overdue, each without an active session.
        $missed = $this->missedToday($user, $now, $end)->keyBy('task_id');
        $due = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->where('due_at', '<', $end->utc())->orderBy('due_at')->orderBy('id')->limit(100)->get();
        $tasks = $due->concat(Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereIn('id', $missed->keys()->all())->get())->unique('id')->values();
        $active = $this->scheduler->activeSessions($user->id, $tasks->pluck('id'));

        // Energy only shapes the size of a new session (never which tasks are placed or in what order): a low-energy day gets shorter bites.
        $energy = CheckinService::enabled($user) ? $this->checkins->forDate($user, $today->toDateString())?->energy : null;
        $lowEnergy = $energy !== null && $energy <= 2;
        $cap = $lowEnergy ? self::LOW_ENERGY_SESSION_MINUTES : self::MAX_SESSION_MINUTES;
        $candidates = [];
        $slippedMissed = 0;
        $slippedDue = 0;
        foreach ($tasks as $task) {
            $mine = $active->get($task->id, collect());
            $future = (int) $mine->sum(fn ($e) => max($e->starts_at, $now)->diffInMinutes($e->ends_at));
            if ($mine->isNotEmpty() && ! $task->split_sessions) {
                continue; // one active session per ordinary task: it is already on the calendar
            }
            $remaining = max(0, $task->estimated_minutes - (int) $task->actual_minutes - ($task->split_sessions ? $future : 0));
            if ($task->split_sessions && $mine->isNotEmpty() && $remaining < 15) {
                continue;
            }
            $wasMissed = $missed->has($task->id);
            $isDue = $task->due_at !== null && $task->due_at < $end;
            $minutes = $wasMissed ? (int) $missed[$task->id]['minutes'] : (int) max(15, min($cap, (int) ceil($remaining / 5) * 5));
            $minutes = max(15, min(AssistantActions::MAX_BLOCK_MINUTES, $minutes));
            $candidates[] = ['task' => $task, 'minutes' => $minutes, 'missed' => $wasMissed ? $missed[$task->id] : null, 'due' => $isDue, 'cut' => ! $wasMissed && $remaining > $cap];
            $wasMissed ? $slippedMissed++ : $slippedDue++;
        }

        // 2. Order: always urgency first (BriefingService::rank), whatever the energy.
        $ranked = BriefingService::rank(collect($candidates)->pluck('task'), $now, $this->goals->pressure($user));
        $position = array_flip($ranked->map(fn (array $row) => $row['task']->id)->all());
        usort($candidates, fn (array $a, array $b) => $position[$a['task']->id] <=> $position[$b['task']->id]);

        // 3. Free time per day: work hours, around all busy time (LifeOS and connected), prayer/iftar windows and breaks.
        $horizon = $today->addDays(14);
        $occurrences = $this->calendar->occurrences($user, $today->utc(), $horizon->utc());
        $closed = $this->calendar->closedTaskIds($user, $occurrences);
        $live = $occurrences->reject(fn (array $o) => isset($o['task_id']) && $closed->has($o['task_id']))->values();
        $busy = $live->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();
        $earliest = $now->addMinutes(15)->startOfMinute();
        $earliest = $earliest->addMinutes((5 - $earliest->minute % 5) % 5);
        $days = [];
        $workDays = 0;
        for ($d = 0; $d < 14 && $workDays < self::LOOKAHEAD_WORK_DAYS; $d++) {
            $local = $today->addDays($d);
            if (! in_array($local->dayOfWeek, $c['work_days'], true)) {
                continue;
            }
            $workDays += $d > 0 ? 1 : 0;
            [$ws, $we] = $this->planning->workHours($c, $local);
            $from = max($local->setTimeFromTimeString($ws), $d === 0 ? $earliest : $local);
            $to = $local->setTimeFromTimeString($we);
            $free = $this->planning->freeIntervals($from->utc(), $to->utc(), $busy, $c['break'], $c);
            $days[$d] = ['local' => $local, 'free' => $free, 'capacity' => $d === 0 ? $this->capacityBetween($c, $from, $to) : 0];
        }

        // 4. Place each candidate in the first free slot (today after now, else the next work days).
        $creates = [];
        $unplaced = [];
        $late = [];
        $cut = [];
        $shortened = [];
        $spillMinutes = 0;
        $limit = self::MAX_ACTIONS;
        $deferred = [];
        foreach ($candidates as $cand) {
            /** @var Task $task */
            $task = $cand['task'];
            if (count($creates) >= $limit) {
                $deferred[] = $task->title;

                continue;
            }
            $placed = null;
            foreach ($days as $d => &$day) {
                $minutes = $cand['minutes'];
                $slot = $this->actions->takeSlot($day['free'], $minutes, $c['break']);
                if (! $slot && $d === 0 && ! $cand['missed']) {
                    $largest = (int) (collect($day['free'])->map(fn (array $f) => (int) $f[0]->diffInMinutes($f[1]))->max() ?? 0);
                    if ($largest >= 30) {
                        $minutes = (int) (floor($largest / 5) * 5);
                        $slot = $this->actions->takeSlot($day['free'], $minutes, $c['break']);
                        $slot && $shortened[] = $task->title.' ('.$minutes.')';
                    }
                }
                if ($slot) {
                    $placed = ['day' => $d, 'slot' => $slot, 'minutes' => $minutes];
                    break;
                }
            }
            unset($day);
            if (! $placed) {
                $unplaced[] = $task->title;
                $spillMinutes += $cand['minutes'];

                continue;
            }
            if ($placed['day'] !== 0) {
                $spillMinutes += $placed['minutes'];
            } else {
                $spillMinutes += $cand['minutes'] - $placed['minutes'];
            }
            $isLate = $task->due_at && $task->due_at > $now && $placed['slot'][1] > $task->due_at;
            $isLate && $late[] = $task->title;
            $cand['cut'] && $cut[] = $task->title;
            $creates[] = [
                'type' => 'create_event', 'title' => mb_substr($task->title, 0, 200), 'task_id' => $task->id,
                'starts_at' => $placed['slot'][0]->utc()->toIso8601String(), 'ends_at' => $placed['slot'][1]->utc()->toIso8601String(), 'minutes' => $placed['minutes'],
                'source' => $cand['missed'] ? 'missed' : 'due',
                'reason' => $this->placementReason($ar, $c['tz'], $now, $task, $cand, $placed['slot'][0], $isLate),
            ];
        }

        // 5. Overflow: if today is still over capacity, the lowest-priority movable future sessions go to the next days with room.
        $moves = [];
        $todayDay = $days[0] ?? null;
        $movedMinutes = 0;
        $overflowLine = null;
        if ($todayDay && count($creates) < $limit && $this->remainingWindow($c, $now)) {
            $capacity = $todayDay['capacity'];
            $freeNow = (int) collect($todayDay['free'])->sum(fn (array $f) => (int) $f[0]->diffInMinutes($f[1]));
            $loadPercent = $capacity > 0 ? (int) round(($capacity - $freeNow) / $capacity * 100) : 0;
            $spilledToday = $spillMinutes;
            if ($capacity > 0 && ($loadPercent >= self::OVERLOAD_PERCENT || $spilledToday > 0)) {
                // Free what could not be placed today; with nothing spilled, bring an overloaded day back under the target share.
                $need = $spilledToday > 0 ? (int) $spilledToday : (int) ceil(max(0, $loadPercent - self::TARGET_PERCENT) / 100 * $capacity);
                $overflowTasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereIn('id', $live->pluck('task_id')->filter()->unique()->all())->get()->keyBy('id');
                $movable = $this->actions->movable($user, $live)->filter(fn (array $o) => $o['starts_at'] >= $now && $o['starts_at'] < $end
                    && ! collect($creates)->contains('task_id', $o['task_id'] ?? null))
                    ->sortBy(fn (array $o) => [isset($o['task_id'], $overflowTasks[$o['task_id']]) ? BriefingService::score($overflowTasks[$o['task_id']], $now, [])['score'] : 0, -$o['starts_at']->getTimestamp()])
                    ->values();
                foreach ($movable as $o) {
                    if ($need <= 0 || count($creates) + count($moves) >= $limit) {
                        break;
                    }
                    $minutes = (int) $o['starts_at']->diffInMinutes($o['ends_at']);
                    $deadline = isset($o['task_id'], $overflowTasks[$o['task_id']]) ? $overflowTasks[$o['task_id']]->due_at : null;
                    foreach ($days as $d => &$day) {
                        if ($d === 0) {
                            continue;
                        }
                        $trial = $day['free'];
                        $slot = $this->actions->takeSlot($trial, $minutes, $c['break']);
                        if (! $slot) {
                            continue;
                        }
                        if ($deadline && $slot[1] > $deadline) {
                            break; // moving it would push it past its deadline: it stays where it is
                        }
                        $day['free'] = $trial;
                        $moves[] = ['occurrence' => $o, 'slot' => $slot, 'minutes' => $minutes, 'day' => $day['local']];
                        $need -= $minutes;
                        $movedMinutes += $minutes;
                        break;
                    }
                    unset($day);
                }
                if ($moves !== []) {
                    $overflowLine = [$loadPercent, $capacity];
                }
            }
        }

        $actions = [];
        foreach ($creates as $a) {
            $actions[] = ['id' => 'a'.(count($actions) + 1)] + $a;
        }
        foreach ($moves as $m) {
            $day = $this->dayLabel($ar, $now, $m['slot'][0]);
            $reason = $t("“{$m['occurrence']['title']}” is flexible and the lowest priority on a full day, so it moves to {$day} at {$m['slot'][0]->setTimezone($c['tz'])->format('H:i')}.",
                "«{$m['occurrence']['title']}» مرنة وأقل أولوية في يوم ممتلئ، فتنتقل إلى {$day} الساعة {$m['slot'][0]->setTimezone($c['tz'])->format('H:i')}.");
            $action = $this->actions->moveAction($user, $m['occurrence'], $m['slot'][0], $m['slot'][1], $reason, 'a'.(count($actions) + 1));
            $actions[] = $action + ['source' => 'overflow'];
        }

        // 6. Say what slipped, what was done, what did not fit and why.
        if ($slippedMissed + $slippedDue > 0) {
            $explanation[] = $t("What slipped: {$slippedMissed} missed session(s) today and {$slippedDue} task(s) due or overdue without a session.",
                "ما الذي تأخر: {$slippedMissed} جلسات فائتة اليوم و{$slippedDue} مهام مستحقة أو متأخرة بلا جلسة.");
        }
        if ($creates !== []) {
            $explanation[] = $t('New sessions go in the first free time after now, around everything on your calendar (including connected calendars), your breaks'.(($c['prayer'] instanceof PrayerTimes && $c['prayer']->enabled()) ? ', and prayer and iftar times' : '').'. Missed blocks stay as history.',
                'الجلسات الجديدة في أول وقت فارغ بعد الآن، حول كل ما في تقويمك (بما فيه التقاويم المرتبطة) واستراحاتك'.(($c['prayer'] instanceof PrayerTimes && $c['prayer']->enabled()) ? ' وأوقات الصلاة والإفطار' : '').'. تبقى الفترات الفائتة في السجل.');
            $explanation[] = $t('Most urgent first (overdue, high priority, due soon).', 'الأكثر إلحاحاً أولاً (المتأخرة، ثم الأولوية العالية، ثم الأقرب موعداً).');
        }
        if ($lowEnergy && $candidates !== []) {
            $explanation[] = $t("Your energy today is low ({$energy}/5), so new sessions are shorter (at most ".self::LOW_ENERGY_SESSION_MINUTES.' minutes).', "طاقتك اليوم منخفضة ({$energy}/5)، فالجلسات الجديدة أقصر (".self::LOW_ENERGY_SESSION_MINUTES.' دقيقة كحد أقصى).');
        }
        if ($overflowLine) {
            $explanation[] = $t("Today is {$overflowLine[0]}% booked against the {$overflowLine[1]} minutes left in your working hours, so the lowest-priority flexible sessions move to the next days with room ({$movedMinutes} minutes).",
                "اليوم محجوز بنسبة {$overflowLine[0]}٪ من {$overflowLine[1]} دقيقة متبقية من ساعات عملك، فتنتقل الجلسات المرنة الأقل أولوية إلى أقرب أيام فيها متسع ({$movedMinutes} دقيقة).");
            $explanation[] = $t('Moved sessions free time today for you; new sessions never use that time, so you can accept each change on its own.', 'الجلسات المنقولة تُفرغ وقتاً اليوم لك؛ ولا تستخدمه الجلسات الجديدة، فيمكنك قبول كل تغيير على حدة.');
        }
        if ($shortened) {
            $explanation[] = $t('Shortened to fit today: '.implode(', ', $shortened).' minutes.', 'قُصّرت لتناسب اليوم: '.implode('، ', $shortened).' دقيقة.');
        }
        if ($cut) {
            $explanation[] = $t('Only the first '.$cap.' minutes were placed for: '.implode(', ', $cut).'. Ask again later for the rest, or split the task.', 'وُضعت أول '.$cap.' دقيقة فقط لـ: '.implode('، ', $cut).'. اطلب مجدداً لاحقاً لبقية الوقت، أو قسّم المهمة.');
        }
        if ($late) {
            $explanation[] = $t('These now land after their deadline: '.implode(', ', $late).'. Consider moving the deadline or dropping something.', 'ستقع هذه بعد موعدها النهائي: '.implode('، ', $late).'. فكّر في تأجيل الموعد أو إلغاء شيء.');
        }
        if ($unplaced) {
            $explanation[] = $t('No room in the next '.self::LOOKAHEAD_WORK_DAYS.' work days for: '.implode(', ', $unplaced).'. Consider splitting or dropping them.', 'لا يتسع الوقت خلال أيام العمل الخمسة القادمة لـ: '.implode('، ', $unplaced).'. فكّر في تقسيمها أو إلغائها.');
        }
        if ($deferred) {
            $explanation[] = $t('Limit of '.self::MAX_ACTIONS.' changes reached; not handled yet: '.implode(', ', $deferred).'. Apply these and ask again.', 'بلغت الحد الأقصى ('.self::MAX_ACTIONS.' تغييرات)؛ لم تُعالج بعد: '.implode('، ', $deferred).'. طبّق هذه ثم اطلب مجدداً.');
        }

        $placedCount = count($creates);
        $summary = match (true) {
            $actions !== [] => $t("Reorganized your day: {$placedCount} new session(s)".(count($moves) ? ' and '.count($moves).' move(s)' : '').'. Review and choose what to apply; nothing changes until you do.',
                "إعادة تنظيم يومك: {$placedCount} جلسات جديدة".(count($moves) ? ' و'.count($moves).' نقل' : '').'. راجعها واختر ما تطبّقه؛ لا يتغير شيء قبل ذلك.'),
            $candidates !== [] => $t('Something slipped, but there is no room to place it in the next '.self::LOOKAHEAD_WORK_DAYS.' work days. Consider splitting or dropping: '.implode(', ', $unplaced).'.', 'تأخر شيء لكن لا يوجد متسع لوضعه خلال أيام العمل الخمسة القادمة. فكّر في تقسيم أو إلغاء: '.implode('، ', $unplaced).'.'),
            default => $t('Nothing has slipped: no missed sessions, nothing due without a session, and today is not overloaded.', 'لا شيء متأخر: لا جلسات فائتة ولا مهام مستحقة بلا جلسة، واليوم غير مزدحم.'),
        };

        return ['actions' => $actions, 'summary' => $summary, 'explanation' => $actions === [] && $candidates === [] ? [] : $explanation];
    }

    /**
     * Today's task sessions that ended in the past while their task is still open (see PlanningService::missedBlocks).
     *
     * @return Collection<int, array{event_id: int, task_id: int, title: string, starts_at: string, ends_at: string, minutes: int}>
     */
    private function missedToday(User $user, CarbonImmutable $now, CarbonImmutable $end): Collection
    {
        return $this->planning->missedBlocks($user)->filter(function (array $m) use ($now, $end) {
            $start = CarbonImmutable::parse($m['starts_at']);

            return $start >= $now->startOfDay() && $start < $end && CarbonImmutable::parse($m['ends_at']) <= $now;
        })->values();
    }

    /**
     * What is left of today's working hours (from now), or null on a non-work day or after the work day ends.
     *
     * @param  array<string, mixed>  $c
     * @return array{0: CarbonImmutable, 1: CarbonImmutable}|null
     */
    private function remainingWindow(array $c, CarbonImmutable $now): ?array
    {
        $day = $now->startOfDay();
        if (! in_array($day->dayOfWeek, $c['work_days'], true)) {
            return null;
        }
        [$ws, $we] = $this->planning->workHours($c, $day);
        $from = max($day->setTimeFromTimeString($ws), $now);
        $to = $day->setTimeFromTimeString($we);

        return $from < $to ? [$from, $to] : null;
    }

    /**
     * @param  array<string, mixed>  $c
     * @param  array{0: CarbonImmutable, 1: CarbonImmutable}  $window
     */
    private function capacity(array $c, array $window): int
    {
        return $this->capacityBetween($c, $window[0], $window[1]);
    }

    /**
     * @param  array<string, mixed>  $c
     */
    private function capacityBetween(array $c, CarbonImmutable $from, CarbonImmutable $to): int
    {
        return $to > $from ? max(0, (int) $from->diffInMinutes($to) - $this->planning->protectedMinutes($c, $from, $to)) : 0;
    }

    private function dayLabel(bool $ar, CarbonImmutable $now, CarbonImmutable $at): string
    {
        $local = $at->setTimezone($now->getTimezone());
        if ($local->isSameDay($now)) {
            return $ar ? 'اليوم' : 'today';
        }
        if ($local->isSameDay($now->addDay())) {
            return $ar ? 'غداً' : 'tomorrow';
        }

        return $local->locale($ar ? 'ar' : 'en')->translatedFormat('l j F');
    }

    /**
     * @param  array<string, mixed>  $cand
     */
    private function placementReason(bool $ar, string $tz, CarbonImmutable $now, Task $task, array $cand, CarbonImmutable $start, bool $late): string
    {
        $when = $this->dayLabel($ar, $now, $start).($ar ? ' الساعة ' : ' at ').$start->setTimezone($tz)->format('H:i');
        if ($cand['missed']) {
            $was = CarbonImmutable::parse($cand['missed']['starts_at'])->setTimezone($tz)->format('H:i').'–'.CarbonImmutable::parse($cand['missed']['ends_at'])->setTimezone($tz)->format('H:i');
            $reason = $ar ? "فاتتك جلسة هذه المهمة ({$was})؛ جلسة جديدة بالمدة نفسها {$when}." : "You missed this task’s session ({$was}); a new one of the same length is placed {$when}.";
        } elseif ($task->due_at && $task->due_at < $now) {
            $reason = $ar ? "متأخرة منذ {$task->due_at->setTimezone($tz)->toDateString()} وبلا جلسة؛ وُضعت {$when}." : "Overdue since {$task->due_at->setTimezone($tz)->toDateString()} with no session; placed {$when}.";
        } elseif ($cand['due']) {
            $reason = $ar ? "مستحقة اليوم وبلا جلسة؛ وُضعت {$when}." : "Due today with no session; placed {$when}.";
        } else {
            $reason = $ar ? "وُضعت {$when}." : "Placed {$when}.";
        }

        return $late ? $reason.($ar ? ' تقع بعد موعدها النهائي.' : ' This is after its deadline.') : $reason;
    }

    /**
     * An open 'reorganize' proposal made in the last REUSE_MINUTES that holds the same actions (same sessions, same days, lengths and order) and whose
     * slots are still free. Times are not compared exactly: they move with "now", and the apply step re-checks every slot anyway.
     *
     * @param  list<array<string, mixed>>  $actions
     */
    private function reusable(User $user, array $actions): ?AssistantProposal
    {
        $tz = $this->planning->config($user)['tz'];
        // Same sessions, same days and lengths, in the same order through the day.
        $sign = fn (array $list) => collect($list)->sortBy(fn (array $a) => CarbonImmutable::parse($a['starts_at'])->getTimestamp())
            ->map(fn (array $a) => implode('|', [$a['type'], $a['task_id'] ?? $a['event_id'] ?? '', CarbonImmutable::parse($a['starts_at'])->setTimezone($tz)->toDateString(), $a['minutes']]))->values()->all();
        $existing = AssistantProposal::where('user_id', $user->id)->where('kind', self::KIND)->where('status', 'pending')->where('expires_at', '>', now())
            ->where('created_at', '>=', now()->subMinutes(self::REUSE_MINUTES))->latest()->first();
        if (! $existing || $sign($existing->actions) !== $sign($actions)) {
            return null;
        }
        foreach ($existing->actions as $a) {
            $start = CarbonImmutable::parse($a['starts_at']);
            if ($start < now()->addMinutes(5) || $this->calendar->conflicts($user, $start, CarbonImmutable::parse($a['ends_at']), $a['event_id'] ?? null)->isNotEmpty()) {
                return null;
            }
        }

        return $existing;
    }
}
