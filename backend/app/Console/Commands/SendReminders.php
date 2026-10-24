<?php

namespace App\Console\Commands;

use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Console\Command;

class SendReminders extends Command
{
    protected $signature = 'lifeos:reminders';

    protected $description = 'Create deduplicated in-app reminders, respecting quiet hours and active focus.';

    public function handle(): int
    {
        User::query()->chunkById(100, function ($users): void {
            foreach ($users as $user) {
                $prefs = UserSetting::where('user_id', $user->id)->first()?->preferences ?? [];
                if (($prefs['notifications'] ?? true) === false || FocusSession::where('user_id', $user->id)->where('status', 'running')->exists()) {
                    continue;
                }
                $now = now($prefs['timezone'] ?? 'UTC');
                $time = $now->format('H:i');
                $start = $prefs['quiet_start'] ?? null;
                $end = $prefs['quiet_end'] ?? null;
                if ($start && $end && ($start < $end ? ($time >= $start && $time < $end) : ($time >= $start || $time < $end))) {
                    continue;
                }
                $ar = ($prefs['language'] ?? 'en') === 'ar';
                $openTasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled']);
                foreach ((clone $openTasks)->whereNotNull('remind_at')->whereBetween('remind_at', [now()->subDay(), now()])->cursor() as $task) {
                    InboxNotification::firstOrCreate(['deduplication_key' => 'remind:'.$task->id.':'.$task->remind_at->timestamp], ['user_id' => $user->id, 'kind' => 'reminder', 'link' => '/tasks', 'title' => ($ar ? 'تذكير: ' : 'Reminder: ').mb_substr($task->title, 0, 200)]);
                }
                foreach ((clone $openTasks)->whereNotNull('due_at')->where('due_at', '<=', now()->addHour())->cursor() as $task) {
                    $overdue = $task->due_at->isPast();
                    InboxNotification::firstOrCreate(['deduplication_key' => 'task:'.$task->id.':'.$task->due_at->timestamp], ['user_id' => $user->id, 'kind' => $overdue ? 'overdue' : 'due', 'link' => '/tasks', 'title' => ($overdue ? ($ar ? 'مهمة متأخرة: ' : 'Overdue: ') : ($ar ? 'موعد المهمة: ' : 'Task due: ')).mb_substr($task->title, 0, 200)]);
                }
                foreach (CalendarEvent::where('user_id', $user->id)->whereBetween('starts_at', [now(), now()->addMinutes(30)])->cursor() as $event) {
                    InboxNotification::firstOrCreate(['deduplication_key' => 'event:'.$event->id.':'.$event->starts_at->timestamp], ['user_id' => $user->id, 'kind' => 'event', 'link' => '/calendar', 'title' => ($ar ? 'موعد قادم: ' : 'Upcoming: ').mb_substr($event->title, 0, 200)]);
                }
                if ($time >= ($prefs['work_start'] ?? '09:00')) {
                    InboxNotification::firstOrCreate(['deduplication_key' => 'daily:'.$user->id.':'.$now->toDateString()], ['user_id' => $user->id, 'kind' => 'planning', 'link' => '/planning', 'title' => $ar ? 'حان وقت مراجعة خطة اليوم' : 'Time to review today’s plan']);
                }
                if ($now->dayOfWeek === 0 && $time >= '17:00') {
                    InboxNotification::firstOrCreate(['deduplication_key' => 'weekly:'.$user->id.':'.$now->toDateString()], ['user_id' => $user->id, 'kind' => 'review', 'link' => '/analytics', 'title' => $ar ? 'راجع أسبوعك وخطط للأسبوع القادم' : 'Review your week and plan the next']);
                }
            }
        });

        return self::SUCCESS;
    }
}
