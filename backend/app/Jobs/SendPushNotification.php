<?php

namespace App\Jobs;

use App\Integrations\Push\PushException;
use App\Integrations\Push\WebPush;
use App\Models\InboxNotification;
use App\Models\PushSubscription;
use App\Models\User;
use App\Services\QuickActions;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Deliver one notification to every push subscription of its owner. Idempotent: a notification that was already
 * delivered is never sent again; transient failures retry with backoff; gone subscriptions are removed.
 */
class SendPushNotification implements ShouldBeUnique, ShouldQueue
{
    use Queueable;

    public int $tries = 4;

    public const BACKOFF = [30, 120, 600];

    public function __construct(public int $notificationId) {}

    public function uniqueId(): string
    {
        return (string) $this->notificationId;
    }

    public function handle(WebPush $push): void
    {
        $notification = InboxNotification::find($this->notificationId);
        if (! $notification || in_array($notification->push_status, ['sent', 'failed', null], true)) {
            return;
        }
        $subscriptions = PushSubscription::where('user_id', $notification->user_id)->get();
        if ($subscriptions->isEmpty()) {
            $notification->update(['push_status' => 'no_device']);

            return;
        }
        $language = User::find($notification->user_id)?->preferences()['language'] ?? 'en';
        $payload = json_encode(['id' => $notification->id, 'title' => $notification->title, 'body' => $notification->body, 'link' => $notification->link ?: '/', 'category' => $notification->category, 'tag' => 'lifeos-'.$notification->id, 'actions' => QuickActions::for($notification, $language)], JSON_UNESCAPED_UNICODE);
        $delivered = 0;
        $errors = [];
        $retry = false;
        foreach ($subscriptions as $subscription) {
            try {
                $status = $push->send($subscription->endpoint, $subscription->public_key, $subscription->auth_token, $payload);
            } catch (PushException $e) {
                $errors[] = $e->getMessage();
                $retry = true;

                continue;
            }
            if ($status >= 200 && $status < 300) {
                $delivered++;
                $subscription->update(['last_used_at' => now(), 'failures' => 0]);
            } elseif (in_array($status, [404, 410], true)) {
                $subscription->delete();
                $errors[] = 'A device unsubscribed.';
            } elseif ($status === 429 || $status >= 500) {
                $retry = true;
                $errors[] = "Push service returned {$status}.";
            } else {
                $subscription->increment('failures');
                if ($subscription->failures >= 5) {
                    $subscription->delete();
                }
                $errors[] = "Push service rejected the message ({$status}).";
            }
        }
        $attempts = $notification->push_attempts + 1;
        if ($delivered > 0) {
            $notification->update(['push_status' => 'sent', 'pushed_at' => now(), 'push_attempts' => $attempts, 'push_error' => null]);
        } elseif ($retry && $this->attempts() < $this->tries) {
            $notification->update(['push_status' => 'retrying', 'push_attempts' => $attempts, 'push_error' => mb_substr(implode(' ', array_unique($errors)), 0, 200)]);
            $this->release(self::BACKOFF[min($this->attempts() - 1, count(self::BACKOFF) - 1)]);
        } else {
            $notification->update(['push_status' => 'failed', 'push_attempts' => $attempts, 'push_error' => mb_substr(implode(' ', array_unique($errors)) ?: 'Not delivered.', 0, 200)]);
        }
    }
}
