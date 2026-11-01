<?php

namespace App\Services;

use App\Models\InboxNotification;

/**
 * One-tap actions offered with a notification: "Done" on a habit reminder, "Done" and a snooze on a task reminder or
 * deadline, "Start break" / "Focus again" when a focus session ends. Each action is only an in-app link; the app performs it when it opens (with Undo), so a tap
 * on a notification never changes data without the signed-in app.
 */
class QuickActions
{
    /**
     * @return list<array{action: string, title: string, link: string}>
     */
    public static function for(InboxNotification $notification, string $language = 'en'): array
    {
        $ar = $language === 'ar';
        if ($notification->kind === 'habit' && preg_match('#^/\?habit=(\d+)$#', (string) $notification->link, $m)) {
            return [['action' => 'habit-done', 'title' => $ar ? 'تم' : 'Done', 'link' => "/?habit={$m[1]}&done=1"]];
        }
        if (in_array($notification->kind, ['reminder', 'due', 'overdue'], true) && preg_match('#^/tasks\?task=(\d+)$#', (string) $notification->link, $m)) {
            // A reminder comes back in an hour; a deadline moves to tomorrow. The app does it when it opens, with Undo.
            $snooze = $notification->kind === 'reminder'
                ? ['action' => 'task-snooze', 'title' => $ar ? 'بعد ساعة' : 'In 1 hour', 'link' => "/?task={$m[1]}&snooze=hour"]
                : ['action' => 'task-snooze', 'title' => $ar ? 'غداً' : 'Tomorrow', 'link' => "/?task={$m[1]}&snooze=tomorrow"];

            return [['action' => 'task-done', 'title' => $ar ? 'تم' : 'Done', 'link' => "/?task={$m[1]}&done=1"], $snooze];
        }
        if ($notification->category === 'focus' && $notification->kind === 'focus') {
            return [
                ['action' => 'focus-break', 'title' => $ar ? 'ابدأ استراحة' : 'Start break', 'link' => '/?focus=break'],
                ['action' => 'focus-again', 'title' => $ar ? 'تركيز مجدداً' : 'Focus again', 'link' => '/?focus=start'],
            ];
        }

        return [];
    }
}
