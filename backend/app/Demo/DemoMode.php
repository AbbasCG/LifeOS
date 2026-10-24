<?php

namespace App\Demo;

use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Guards and housekeeping for the local demo account. Everything here is scoped to the single demo user,
 * identified by both its configured email address and a marker in its settings, so real accounts are never touched.
 */
class DemoMode
{
    public const MARKER = 'demo_account';

    /** Tables with a user_id column, deleted children-first. */
    public const OWNED_TABLES = [
        'automation_runs', 'automation_rules', 'assistant_proposals', 'inbox_notifications', 'push_subscriptions',
        'external_events', 'calendar_accounts', 'calendar_events', 'focus_sessions', 'weekly_reviews', 'schedule_proposals',
        'tasks', 'habits', 'goals', 'projects', 'categories',
    ];

    public static function allowed(): bool
    {
        return ! app()->isProduction() && app()->environment(['local', 'testing']) && (bool) config('demo.enabled');
    }

    public static function assertAllowed(): void
    {
        if (! self::allowed()) {
            throw new RuntimeException('Demo data is disabled. It only runs in the local or testing environment with LIFEOS_DEMO_ENABLED=true.');
        }
    }

    /**
     * The existing demo user, or null. Throws when the demo email belongs to an account that isn't marked as demo.
     */
    public static function user(): ?User
    {
        $user = User::where('email', config('demo.email'))->first();
        if ($user && ! self::isDemo($user)) {
            throw new RuntimeException('The demo email address belongs to an account that is not a demo account. Refusing to touch it; set LIFEOS_DEMO_EMAIL to another address.');
        }

        return $user;
    }

    public static function isDemo(User $user): bool
    {
        return $user->email === config('demo.email') && (UserSetting::where('user_id', $user->id)->first()?->preferences[self::MARKER] ?? false) === true;
    }

    /**
     * Delete every record owned by the demo user, keeping the account itself (unless $removeAccount).
     *
     * @return array<string, int> deleted rows per table
     */
    public static function reset(User $user, bool $removeAccount = false): array
    {
        self::assertAllowed();
        if (! self::isDemo($user)) {
            throw new RuntimeException('Not a demo account.');
        }

        return DB::transaction(function () use ($user, $removeAccount) {
            $deleted = [];
            $habitIds = DB::table('habits')->where('user_id', $user->id)->pluck('id');
            $deleted['habit_entries'] = DB::table('habit_entries')->whereIn('habit_id', $habitIds)->delete();
            $eventIds = DB::table('calendar_events')->where('user_id', $user->id)->pluck('id');
            $deleted['calendar_event_exceptions'] = DB::table('calendar_event_exceptions')->whereIn('calendar_event_id', $eventIds)->delete();
            foreach (self::OWNED_TABLES as $table) {
                $deleted[$table] = DB::table($table)->where('user_id', $user->id)->delete();
            }
            $deleted['sessions'] = DB::table('sessions')->where('user_id', $user->id)->delete();
            if ($removeAccount) {
                $deleted['audit_logs'] = DB::table('audit_logs')->where('user_id', $user->id)->delete();
                $deleted['user_settings'] = DB::table('user_settings')->where('user_id', $user->id)->delete();
                $deleted['users'] = DB::table('users')->where('id', $user->id)->delete();
            }

            return array_filter($deleted);
        });
    }
}
