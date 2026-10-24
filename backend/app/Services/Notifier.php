<?php

namespace App\Services;

use App\Integrations\Push\WebPush;
use App\Jobs\SendPushNotification;
use App\Models\FocusSession;
use App\Models\InboxNotification;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Single entry point for notifications: per-category preferences, quiet hours, deduplication,
 * an in-app history record, and (optionally) queued browser push with retries.
 */
class Notifier
{
    public const CATEGORIES = ['reminders', 'deadlines', 'calendar', 'focus', 'planning', 'review', 'system'];

    /** Push is opt-in per device; these categories push by default once a device is enabled. */
    public const PUSH_DEFAULTS = ['reminders' => true, 'deadlines' => true, 'calendar' => true, 'focus' => true, 'planning' => false, 'review' => false, 'system' => false];

    public function __construct(private WebPush $push) {}

    /**
     * Effective channel settings per category.
     *
     * @param  array<string, mixed>  $prefs
     * @return array<string, array{enabled: bool, push: bool}>
     */
    public static function channels(array $prefs): array
    {
        $saved = $prefs['notification_channels'] ?? [];

        return collect(self::CATEGORIES)->mapWithKeys(fn (string $c) => [$c => [
            'enabled' => $c === 'system' ? true : (bool) ($saved[$c]['enabled'] ?? true),
            'push' => (bool) ($saved[$c]['push'] ?? self::PUSH_DEFAULTS[$c]),
        ]])->all();
    }

    /**
     * @param  array<string, mixed>  $prefs
     */
    public static function inQuietHours(array $prefs): bool
    {
        $start = $prefs['quiet_start'] ?? null;
        $end = $prefs['quiet_end'] ?? null;
        if (! $start || ! $end || $start === $end) {
            return false;
        }
        $time = now($prefs['timezone'] ?? 'UTC')->format('H:i');

        return $start < $end ? ($time >= $start && $time < $end) : ($time >= $start || $time < $end);
    }

    /**
     * Create the notification once per $key. Returns null when it was suppressed by preferences or already sent.
     *
     * @param  array{body?: string|null, link?: string|null, kind?: string, force?: bool}  $options  force bypasses quiet hours (system messages, tests)
     */
    public function send(User $user, string $category, string $key, string $title, array $options = []): ?InboxNotification
    {
        $prefs = $user->preferences();
        $channel = self::channels($prefs)[$category] ?? self::channels([])['system'];
        $force = $options['force'] ?? false;
        if ($category !== 'system' && (($prefs['notifications'] ?? true) === false || ! $channel['enabled'])) {
            return null;
        }
        if (! $force && $category !== 'system' && self::inQuietHours($prefs)) {
            return null;
        }
        try {
            $notification = InboxNotification::firstOrCreate(['deduplication_key' => $key], [
                'user_id' => $user->id, 'category' => $category, 'kind' => $options['kind'] ?? $category,
                'title' => mb_substr($title, 0, 250), 'body' => isset($options['body']) ? mb_substr($options['body'], 0, 1000) : null, 'link' => $options['link'] ?? null,
            ]);
        } catch (UniqueConstraintViolationException) {
            return null;
        }
        if (! $notification->wasRecentlyCreated) {
            return null;
        }

        if ($channel['push'] && $this->push->isConfigured() && PushSubscription::where('user_id', $user->id)->exists()) {
            $focusing = $category !== 'focus' && FocusSession::where('user_id', $user->id)->where('status', 'running')->exists();
            $notification->update(['push_status' => $focusing ? 'suppressed' : 'queued', 'push_error' => $focusing ? 'Focus session in progress' : null]);
            if (! $focusing) {
                SendPushNotification::dispatch($notification->id)->afterCommit();
            }
        }

        return $notification;
    }
}
