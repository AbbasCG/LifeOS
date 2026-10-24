<?php

namespace App\Services;

use App\Models\CalendarAccount;
use App\Models\ExternalEvent;
use App\Models\SyncRun;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * Conflicts across LifeOS and connected data, computed from stable identifiers rather than titles:
 *
 * - overlap: two timed commitments overlap (LifeOS, Google, Outlook — each shown once after de-duplication);
 * - busy_task: LifeOS work (a planned task block or a task's scheduled time) falls inside a fixed or connected commitment;
 * - duplicate: the same meeting (iCalendar UID + occurrence) exists in more than one connected account — informational,
 *   it is displayed once;
 * - timezone: a connected event was organised in another timezone, so its time differs on the organiser's calendar;
 * - moved / cancelled: connected events rescheduled or cancelled upstream in the last 7 days;
 * - deadline: open work due before a deadline needs more time than the meetings leave free.
 */
class ConflictService
{
    public function __construct(private CalendarService $calendar, private PlanningService $planning) {}

    /**
     * @param  Collection<int, array<string, mixed>>|null  $occurrences  already-loaded occurrences for [from, to)
     * @return list<array<string, mixed>>
     */
    public function detect(User $user, CarbonImmutable $from, CarbonImmutable $to, ?Collection $occurrences = null): array
    {
        $tz = $user->timezone();
        $occurrences ??= $this->calendar->occurrences($user, $from, $to);
        $timed = $occurrences->reject(fn (array $o) => $o['all_day'] ?? false)->values();
        $out = [];

        for ($i = 0; $i < $timed->count(); $i++) {
            for ($j = $i + 1; $j < $timed->count() && $timed[$j]['starts_at'] < $timed[$i]['ends_at']; $j++) {
                [$a, $b] = [$timed[$i], $timed[$j]];
                $minutes = (int) max($a['starts_at'], $b['starts_at'])->diffInMinutes(min($a['ends_at'], $b['ends_at']));
                $taskBlock = fn (array $o) => ($o['source'] ?? 'lifeos') === 'lifeos' && ($o['task_id'] ?? null) && ($o['kind'] ?? '') === 'flexible';
                $busy = fn (array $o) => ($o['source'] ?? 'lifeos') !== 'lifeos' || ($o['kind'] ?? '') === 'fixed';
                $type = ($taskBlock($a) && $busy($b)) || ($taskBlock($b) && $busy($a)) ? 'busy_task' : 'overlap';
                $out[] = ['type' => $type, 'severity' => 'high', 'at' => max($a['starts_at'], $b['starts_at'])->toIso8601String(), 'minutes' => $minutes,
                    'items' => ['ev:'.$a['id'], 'ev:'.$b['id']], 'titles' => [$a['title'], $b['title']], 'sources' => [$a['source'] ?? 'lifeos', $b['source'] ?? 'lifeos']];
            }
        }

        // Tasks with an explicit scheduled time that lands inside unavailable time.
        $busyOccurrences = $timed->filter(fn (array $o) => ($o['source'] ?? 'lifeos') !== 'lifeos' || ($o['kind'] ?? '') === 'fixed');
        Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereNotNull('scheduled_start')->whereNotNull('scheduled_end')
            ->where('scheduled_end', '>', $from)->where('scheduled_start', '<', $to)->limit(200)->get()
            ->each(function (Task $task) use ($busyOccurrences, &$out) {
                $hit = $busyOccurrences->first(fn (array $o) => $o['starts_at'] < $task->scheduled_end && $o['ends_at'] > $task->scheduled_start && ($o['task_id'] ?? null) !== $task->id);
                if ($hit) {
                    $out[] = ['type' => 'busy_task', 'severity' => 'high', 'at' => $task->scheduled_start->toIso8601String(), 'minutes' => (int) max($task->scheduled_start, $hit['starts_at'])->diffInMinutes(min($task->scheduled_end, $hit['ends_at'])),
                        'items' => ['task:'.$task->id, 'ev:'.$hit['id']], 'titles' => [$task->title, $hit['title']], 'sources' => ['lifeos', $hit['source'] ?? 'lifeos']];
                }
            });

        $accounts = CalendarAccount::where('user_id', $user->id)->where('status', '!=', 'revoked')->get(['id', 'provider', 'email'])->keyBy('id');
        $external = ExternalEvent::where('user_id', $user->id)->whereIn('calendar_account_id', $accounts->keys())
            ->where('ends_at', '>', $from)->where('starts_at', '<', $to)->get();

        // Same meeting in several accounts (shown once on the timeline).
        $external->whereNotNull('ical_uid')->groupBy(fn (ExternalEvent $e) => CalendarSyncService::identity($e))
            ->filter(fn (Collection $group) => $group->pluck('calendar_account_id')->unique()->count() > 1)
            ->each(function (Collection $group) use (&$out, $accounts) {
                $first = $group->first();
                $out[] = ['type' => 'duplicate', 'severity' => 'info', 'at' => $first->starts_at->toIso8601String(), 'minutes' => 0,
                    'items' => $group->map(fn ($e) => 'ev:x'.$e->id)->values()->all(), 'titles' => [$first->title],
                    'sources' => $group->map(fn ($e) => $accounts[$e->calendar_account_id]->provider)->values()->all(),
                    'accounts' => $group->map(fn ($e) => $accounts[$e->calendar_account_id]->email)->filter()->unique()->values()->all()];
            });

        // Organised in another timezone: the wall-clock time differs between the organiser's zone and the user's.
        $valid = array_flip(timezone_identifiers_list());
        $external->filter(fn (ExternalEvent $e) => ! $e->all_day && $e->timezone && isset($valid[$e->timezone]) && $e->timezone !== $tz
            && $e->starts_at->setTimezone($e->timezone)->format('H:i') !== $e->starts_at->setTimezone($tz)->format('H:i'))
            ->take(20)->each(function (ExternalEvent $e) use (&$out, $tz) {
                $out[] = ['type' => 'timezone', 'severity' => 'info', 'at' => $e->starts_at->toIso8601String(), 'minutes' => 0, 'items' => ['ev:x'.$e->id], 'titles' => [$e->title],
                    'organiser_time' => $e->starts_at->setTimezone($e->timezone)->format('H:i'), 'organiser_zone' => $e->timezone, 'your_time' => $e->starts_at->setTimezone($tz)->format('H:i')];
            });

        // Rescheduled upstream recently.
        $external->filter(fn (ExternalEvent $e) => $e->changed_at && $e->previous_starts_at && $e->changed_at > now()->subDays(7))
            ->each(function (ExternalEvent $e) use (&$out) {
                $out[] = ['type' => 'moved', 'severity' => 'info', 'at' => $e->starts_at->toIso8601String(), 'minutes' => 0, 'items' => ['ev:x'.$e->id], 'titles' => [$e->title],
                    'from' => $e->previous_starts_at->toIso8601String(), 'to' => $e->starts_at->toIso8601String()];
            });

        // Cancelled upstream recently (from sync run details; the events themselves are gone).
        SyncRun::whereIn('calendar_account_id', $accounts->keys())->where('started_at', '>', now()->subDays(7))->whereNotNull('details')->latest('id')->limit(50)->get()
            ->flatMap(fn (SyncRun $r) => collect($r->details['cancelled'] ?? [])->map(fn ($c) => $c + ['provider' => $accounts[$r->calendar_account_id]->provider]))
            ->filter(fn ($c) => isset($c['at']) && CarbonImmutable::parse($c['at'])->betweenIncluded($from, $to))
            ->unique(fn ($c) => $c['title'].$c['at'])->take(10)
            ->each(function ($c) use (&$out) {
                $out[] = ['type' => 'cancelled', 'severity' => 'info', 'at' => $c['at'], 'minutes' => 0, 'items' => [], 'titles' => [$c['title']], 'sources' => [$c['provider']]];
            });

        return [...$out, ...$this->deadlines($user, $occurrences, $from, $to)];
    }

    /**
     * Deadlines whose remaining work needs more time than the meetings leave free before them.
     *
     * @param  Collection<int, array<string, mixed>>  $occurrences
     * @return list<array<string, mixed>>
     */
    public function deadlines(User $user, Collection $occurrences, CarbonImmutable $from, CarbonImmutable $to): array
    {
        $c = $this->planning->config($user);
        $now = CarbonImmutable::now($c['tz']);
        $start = max($from->setTimezone($c['tz'])->startOfDay(), $now->startOfDay());
        $days = (int) max(1, min(31, $start->diffInDays($to) + 1));
        $summary = collect($this->planning->summary($user, $start, $days, [], [], $c)['days'])->keyBy('date');
        $due = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereBetween('due_at', [max($now, $from)->utc(), $to->utc()])->orderBy('due_at')->limit(50)->get();
        $need = 0;
        $out = [];
        foreach ($due as $task) {
            $need += max(0, $task->estimated_minutes - (int) $task->actual_minutes);
            $dueDay = $task->due_at->setTimezone($c['tz'])->toDateString();
            $free = (int) $summary->filter(fn ($d) => $d['date'] < $dueDay)->sum('free_minutes') + (int) round(($summary[$dueDay]['free_minutes'] ?? 0) / 2);
            if ($need > $free) {
                $meetings = $occurrences->filter(fn ($o) => $o['starts_at'] >= $now && $o['starts_at'] < $task->due_at && (($o['source'] ?? 'lifeos') !== 'lifeos' || ($o['kind'] ?? '') === 'fixed'))->values();
                $out[] = ['type' => 'deadline', 'severity' => 'high', 'at' => $task->due_at->toIso8601String(), 'minutes' => $need - $free, 'items' => ['task:'.$task->id], 'titles' => [$task->title],
                    'need' => $need, 'free' => $free, 'meetings' => $meetings->count(), 'meeting_minutes' => (int) $meetings->sum(fn ($o) => $o['starts_at']->diffInMinutes($o['ends_at'])),
                    'connected_meetings' => $meetings->where('source', '!=', 'lifeos')->count()];
            }
        }

        return $out;
    }
}
