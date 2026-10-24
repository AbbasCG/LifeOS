<?php

namespace App\Console\Commands;

use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use App\Services\CalendarService;
use App\Services\Notifier;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;

class SendReminders extends Command
{
    protected $signature = 'lifeos:reminders';

    protected $description = 'Create deduplicated reminders (tasks, deadlines, calendar incl. recurring events, focus, planning, review), respecting preferences and quiet hours.';

    /** Lead time for calendar reminders when an event has none of its own. */
    public const DEFAULT_EVENT_LEAD = 30;

    public function handle(Notifier $notifier, CalendarService $calendar): int
    {
        User::query()->chunkById(100, function ($users) use ($notifier, $calendar): void {
            foreach ($users as $user) {
                try {
                    $this->remind($user, $notifier, $calendar);
                } catch (\Throwable $e) {
                    report($e);
                }
            }
        });

        return self::SUCCESS;
    }

    private function remind(User $user, Notifier $notifier, CalendarService $calendar): void
    {
        $prefs = $user->preferences();
        if (($prefs['notifications'] ?? true) === false) {
            return;
        }
        $tz = $prefs['timezone'] ?? 'UTC';
        $now = CarbonImmutable::now($tz);
        $time = $now->format('H:i');
        $ar = ($prefs['language'] ?? 'en') === 'ar';
        $clock = fn (CarbonImmutable $at) => $at->setTimezone($tz)->format(($prefs['time_format'] ?? '24') === '12' ? 'g:i A' : 'H:i');

        foreach (FocusSession::where('user_id', $user->id)->where('status', 'running')->whereNotNull('resumed_at')->get() as $session) {
            $ends = $session->resumed_at->addSeconds(max(0, $session->duration_seconds - $session->elapsed_seconds));
            if ($ends <= now()) {
                $notifier->send($user, 'focus', 'focus:'.$session->id, $ar ? 'انتهت جلسة التركيز' : 'Focus session complete', ['body' => $ar ? 'خذ استراحة قصيرة ثم سجّل ما أنجزته.' : 'Take a short break, then log what you finished.', 'link' => '/focus', 'force' => true]);
            }
        }
        if (FocusSession::where('user_id', $user->id)->where('status', 'running')->exists()) {
            return;
        }

        $open = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled']);
        foreach ((clone $open)->whereNotNull('remind_at')->whereBetween('remind_at', [now()->subDay(), now()])->cursor() as $task) {
            $notifier->send($user, 'reminders', 'remind:'.$task->id.':'.$task->remind_at->timestamp, ($ar ? 'تذكير: ' : 'Reminder: ').$task->title, ['link' => '/tasks', 'kind' => 'reminder']);
        }
        foreach ((clone $open)->whereNotNull('due_at')->where('due_at', '<=', now()->addHour())->where('due_at', '>=', now()->subDays(7))->cursor() as $task) {
            $overdue = $task->due_at->isPast();
            $notifier->send($user, 'deadlines', 'task:'.$task->id.':'.$task->due_at->timestamp, ($overdue ? ($ar ? 'مهمة متأخرة: ' : 'Overdue: ') : ($ar ? 'موعد المهمة: ' : 'Task due: ')).$task->title, ['link' => '/tasks', 'kind' => $overdue ? 'overdue' : 'due']);
        }

        $default = (int) ($prefs['event_remind_minutes'] ?? self::DEFAULT_EVENT_LEAD);
        foreach ($calendar->occurrences($user, now()->toImmutable(), now()->addDay()->toImmutable()) as $occurrence) {
            $lead = $occurrence['remind_minutes'] ?? $default;
            if ($lead === null || $lead < 0 || $occurrence['starts_at'] <= now() || $occurrence['starts_at']->subMinutes($lead) > now()) {
                continue;
            }
            $at = $clock($occurrence['starts_at']);
            $notifier->send($user, 'calendar', 'event:'.$occurrence['id'].':'.$occurrence['starts_at']->timestamp, ($ar ? 'موعد قادم: ' : 'Upcoming: ').$occurrence['title'], ['body' => ($ar ? 'يبدأ الساعة ' : 'Starts at ').$at, 'link' => '/calendar', 'kind' => 'event']);
        }

        if ($time >= ($prefs['work_start'] ?? '09:00') && in_array($now->dayOfWeek, array_map('intval', $prefs['work_days'] ?? [1, 2, 3, 4, 5]), true)) {
            $notifier->send($user, 'planning', 'daily:'.$user->id.':'.$now->toDateString(), $ar ? 'حان وقت مراجعة خطة اليوم' : 'Time to review today’s plan', ['link' => '/planning']);
        }
        $reviewDay = ((int) ($prefs['week_start'] ?? 1) + 6) % 7;
        if ($now->dayOfWeek === $reviewDay && $time >= '17:00') {
            $notifier->send($user, 'review', 'weekly:'.$user->id.':'.$now->toDateString(), $ar ? 'راجع أسبوعك وخطط للأسبوع القادم' : 'Review your week and plan the next', ['link' => '/review']);
        }
    }
}
