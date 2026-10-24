<?php

namespace App\Services;

use App\Integrations\Calendar\CalendarProviders;
use App\Models\ExternalTask;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * The daily command center: a briefing (morning) or summary (evening), deadlines, real free focus slots,
 * energy/workload, and daily progress — all derived from the user's own data.
 */
class TodayService
{
    public const DEFAULT_FOCUS_TARGET = 240;

    public function __construct(private BriefingService $briefing, private PlanningService $planning, private CalendarService $calendar, private CheckinService $checkins, private GoalIntelligence $goals) {}

    /**
     * @return array<string, mixed>
     */
    public function today(User $user): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $day = $now->startOfDay();
        $base = $this->briefing->today($user);
        $ar = ($user->preferences()['language'] ?? 'en') === 'ar';
        $windows = $this->planning->windows($c, $day);
        $occurrences = $this->calendar->occurrences($user, $day->utc(), $day->addDay()->utc());
        $busy = $occurrences->map(fn (array $o) => [$o['starts_at'], $o['ends_at']])->all();

        $slots = collect($windows)->flatMap(fn (array $w, string $area) => collect($this->planning->freeIntervals(max($w[0], $now)->utc(), $w[1]->utc(), $busy, $c['break']))
            ->map(fn (array $f) => ['area' => $area, 'starts_at' => $f[0]->toIso8601String(), 'ends_at' => $f[1]->toIso8601String(), 'minutes' => (int) $f[0]->diffInMinutes($f[1])]))
            ->filter(fn (array $s) => $s['minutes'] >= 30)->sortBy('starts_at')->values();
        $peak = $c['focus_start'] && $c['focus_end'] ? ['start' => $c['focus_start'], 'end' => $c['focus_end']] : null;

        $deadlines = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereNotNull('due_at')
            ->where('due_at', '<=', $day->addDays(7)->utc())->orderBy('due_at')->limit(12)->get()
            ->map(fn (Task $t) => ['id' => $t->id, 'title' => $t->title, 'priority' => $t->priority, 'due_at' => $t->due_at->toIso8601String(), 'type' => 'task',
                'bucket' => $t->due_at < $now ? 'overdue' : ($t->due_at < $day->addDay() ? 'today' : ($t->due_at < $day->addDays(2) ? 'tomorrow' : 'week'))]);
        $deadlines = $deadlines->concat(Project::where('user_id', $user->id)->where('status', 'active')->whereBetween('due_at', [$now->utc(), $day->addDays(7)->utc()])->get()
            ->map(fn (Project $p) => ['id' => $p->id, 'title' => $p->title, 'priority' => null, 'due_at' => $p->due_at->toIso8601String(), 'type' => 'project', 'bucket' => $p->due_at < $day->addDay() ? 'today' : ($p->due_at < $day->addDays(2) ? 'tomorrow' : 'week')]))
            ->concat($this->goals->goals($user)->filter(fn ($g) => $g['status'] !== 'completed' && $g['days_left'] !== null && $g['days_left'] >= 0 && $g['days_left'] <= 7)
                ->map(fn ($g) => ['id' => $g['id'], 'title' => $g['title'], 'priority' => null, 'due_at' => $g['due_at'], 'type' => 'goal', 'bucket' => $g['days_left'] === 0 ? 'today' : ($g['days_left'] === 1 ? 'tomorrow' : 'week')]))
            ->concat($this->connectedDeadlines($user, $now, $day))
            ->sortBy('due_at')->values();

        $checkin = CheckinService::enabled($user) ? $this->checkins->forDate($user, $day->toDateString()) : null;
        $habits = collect($base['habits']);
        $dueToday = Task::where('user_id', $user->id)->where(fn ($q) => $q->whereBetween('completed_at', [$day->utc(), $day->addDay()->utc()])
            ->orWhere(fn ($q) => $q->whereNotIn('status', ['completed', 'cancelled'])->where('due_at', '<', $day->addDay()->utc())))->get(['status', 'completed_at', 'due_at']);
        $tasksDone = $base['stats']['completed_today'];
        $tasksPlanned = max($tasksDone, $dueToday->count());
        $focusTarget = (int) ($c['daily_limit'] ?? self::DEFAULT_FOCUS_TARGET);
        $progress = [
            'tasks' => ['done' => $tasksDone, 'target' => $tasksPlanned],
            'focus' => ['done' => $base['stats']['focus_minutes_today'], 'target' => $focusTarget],
            'habits' => ['done' => $habits->filter(fn (array $h) => $h['done_this_period'])->count(), 'target' => $habits->count()],
        ];
        $parts = collect($progress)->filter(fn ($p) => $p['target'] > 0)->map(fn ($p) => min(1, $p['done'] / $p['target']));
        $progress['overall'] = $parts->isEmpty() ? 0 : (int) round($parts->avg() * 100);

        $workEnd = isset($windows['work']) ? $windows['work'][1] : $day->setTime(18, 0);
        $evening = $now >= $workEnd->subMinutes(30) || $now->hour >= 18;
        $freeMinutes = (int) $slots->sum('minutes');
        $fixed = $occurrences->where('kind', 'fixed');
        $first = $occurrences->first(fn (array $o) => $o['starts_at'] > $now);
        $top = $base['focus'][0] ?? null;
        $workload = $checkin?->workload;
        $load = $base['stats']['load_percent'];

        $lines = [];
        if ($evening) {
            $lines[] = $this->line($ar, "You completed {$tasksDone} task(s) and focused ".$this->hm($base['stats']['focus_minutes_today'], false).' today.', "أنجزت {$tasksDone} مهمة وركّزت ".$this->hm($base['stats']['focus_minutes_today'], true).' اليوم.');
            $carry = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereBetween('due_at', [$day->utc(), $day->addDay()->utc()])->count();
            $lines[] = $carry ? $this->line($ar, "{$carry} task(s) due today are still open — carry them over or reschedule.", "{$carry} مهمة مستحقة اليوم ما زالت مفتوحة — انقلها أو أعد جدولتها.") : $this->line($ar, 'Nothing due today is left open.', 'لم يبقَ شيء مستحق اليوم مفتوحاً.');
            $lines[] = $this->line($ar, "Habits: {$progress['habits']['done']} of {$progress['habits']['target']} done.", "العادات: {$progress['habits']['done']} من {$progress['habits']['target']}.");
            $tomorrow = $this->calendar->occurrences($user, $day->addDay()->utc(), $day->addDays(2)->utc())->first();
            if ($tomorrow) {
                $lines[] = $this->line($ar, "Tomorrow starts with “{$tomorrow['title']}” at ".$tomorrow['starts_at']->setTimezone($c['tz'])->format('H:i').'.', "يبدأ الغد بـ «{$tomorrow['title']}» الساعة ".$tomorrow['starts_at']->setTimezone($c['tz'])->format('H:i').'.');
            }
        } else {
            $lines[] = $fixed->isEmpty() ? $this->line($ar, 'No fixed commitments today.', 'لا التزامات ثابتة اليوم.') : $this->line($ar, $fixed->count().' fixed commitment(s)'.($first ? ", next: “{$first['title']}” at ".$first['starts_at']->setTimezone($c['tz'])->format('H:i') : '').'.', $fixed->count().' التزامات ثابتة'.($first ? "، التالي: «{$first['title']}» الساعة ".$first['starts_at']->setTimezone($c['tz'])->format('H:i') : '').'.');
            $lines[] = $this->line($ar, $this->hm($freeMinutes, false).' of free focus time in '.$slots->count().' slot(s).', $this->hm($freeMinutes, true).' وقت تركيز متاح في '.$slots->count().' فترات.');
            if ($top) {
                $lines[] = $this->line($ar, "Top priority: “{$top['title']}”.", "الأولوية القصوى: «{$top['title']}».");
            }
            $soon = $deadlines->whereIn('bucket', ['overdue', 'today', 'tomorrow'])->count();
            if ($soon) {
                $lines[] = $this->line($ar, "{$soon} deadline(s) are overdue or due by tomorrow.", "{$soon} مواعيد متأخرة أو مستحقة حتى الغد.");
            }
            if (CheckinService::enabled($user) && ! $checkin) {
                $lines[] = $this->line($ar, 'Check in on your energy to get a plan that fits today.', 'سجّل طاقتك لتحصل على خطة تناسب يومك.');
            } elseif ($checkin?->energy !== null && $checkin->energy <= 2) {
                $lines[] = $this->line($ar, 'Energy is low today — the planner will suggest a lighter day.', 'طاقتك منخفضة اليوم — سيقترح المخطط يوماً أخف.');
            }
        }

        return [
            'date' => $day->toDateString(),
            'period' => $evening ? 'evening' : $base['period'],
            'briefing' => $lines,
            'reflection_prompt' => $evening ? $this->line($ar, 'What went well today, and what would you change tomorrow?', 'ما الذي سار جيداً اليوم، وماذا ستغيّر غداً؟') : null,
            'energy' => ['checkin' => $checkin?->present(), 'enabled' => CheckinService::enabled($user), 'energy' => $checkin?->energy, 'workload' => $workload, 'load_percent' => $load,
                'level' => $load >= 90 || ($workload !== null && $workload >= 4) ? 'heavy' : ($load >= 60 ? 'moderate' : 'light')],
            'focus_time' => ['free_minutes' => $freeMinutes, 'slots' => $slots->take(6)->values(), 'peak' => $peak, 'next_task' => $top],
            // Start of the user's local day, so clients draw the day in the user's timezone, not the browser's.
            'day_start' => $day->toIso8601String(),
            'timezone' => $c['tz'],
            'timeline' => $occurrences->map(fn (array $o) => ['id' => (string) $o['id'], 'title' => $o['title'], 'starts_at' => $o['starts_at']->toIso8601String(), 'ends_at' => $o['ends_at']->toIso8601String(), 'kind' => $o['kind'], 'source' => $o['source'] ?? 'lifeos', 'all_day' => (bool) ($o['all_day'] ?? false)])->values(),
            'windows' => collect($windows)->map(fn (array $w) => ['start' => $w[0]->toIso8601String(), 'end' => $w[1]->toIso8601String()]),
            'deadlines' => $deadlines->take(10)->values(),
            'progress' => $progress,
        ];
    }

    /**
     * @return array{en: string, ar: string}
     */
    private function line(bool $ar, string $en, string $arabic): array
    {
        return ['en' => $en, 'ar' => $arabic];
    }

    private function hm(int $minutes, bool $ar): string
    {
        $h = intdiv($minutes, 60);
        $m = $minutes % 60;

        return $ar ? trim(($h ? "{$h} س " : '').($m || ! $h ? "{$m} د" : '')) : trim(($h ? "{$h}h " : '').($m || ! $h ? "{$m}m" : ''));
    }

    /**
     * Read-only tasks from connected apps due within a week, labelled with their source. Tasks already copied into
     * LifeOS are skipped so nothing appears twice.
     *
     * @return Collection<int, array<string, mixed>>
     */
    private function connectedDeadlines(User $user, CarbonImmutable $now, CarbonImmutable $day): Collection
    {
        $copied = Task::where('user_id', $user->id)->whereNotNull('source_ref')->pluck('source_ref')->flip();
        $labels = collect(app(CalendarProviders::class)->all())->map(fn ($p) => $p->label());

        return ExternalTask::query()->join('calendar_accounts', 'calendar_accounts.id', '=', 'external_tasks.calendar_account_id')
            ->where('external_tasks.user_id', $user->id)->where('calendar_accounts.status', '!=', 'revoked')
            ->where('external_tasks.status', 'open')->whereNotNull('external_tasks.due_at')->where('external_tasks.due_at', '<=', $day->addDays(7)->utc())
            ->orderBy('external_tasks.due_at')->limit(12)->get(['external_tasks.*', 'calendar_accounts.provider'])
            ->reject(fn (ExternalTask $t) => $copied->has($t->sourceRef($t->provider)))
            ->map(fn (ExternalTask $t) => ['id' => $t->id, 'title' => $t->title, 'priority' => $t->priority, 'due_at' => $t->due_at->toIso8601String(), 'type' => 'external', 'source' => $labels[$t->provider] ?? $t->provider, 'url' => $t->url,
                'bucket' => $t->due_at < $now ? 'overdue' : ($t->due_at < $day->addDay() ? 'today' : ($t->due_at < $day->addDays(2) ? 'tomorrow' : 'week'))])
            ->values();
    }
}
