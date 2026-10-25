<?php

namespace App\Services;

use App\Models\User;
use App\Models\UserSetting;

/**
 * The user's AI preferences (stored in user_settings.preferences.intelligence), with safe defaults.
 *
 * Proactive insights are computed on this server from the user's own data. External AI providers are governed
 * separately by the existing switches `assistant_external` and `ai_connected_data`, surfaced in the AI Control Center.
 */
class IntelligenceSettings
{
    public const FEATURES = ['briefing', 'recommendations', 'weekly', 'planner', 'ai_narrative', 'conversation_personalization', 'plan_learning', 'goal_reviews'];

    public const SOURCES = ['calendar', 'connected', 'goals', 'habits', 'focus', 'checkins'];

    public const FREQUENCIES = ['off', 'quiet', 'daily'];

    public const RETENTION = [30, 90, 180];

    public const STRATEGIES = ['balanced', 'deep', 'light', 'deadlines'];

    /**
     * Personalization (of suggestions and of Copilot prompts) is opt-in, AI-written narratives need a separate switch,
     * everything else is on by default. `conversation_reset_at` marks where conversation personalization starts learning.
     */
    public const DEFAULTS = [
        'enabled' => true,
        'features' => ['briefing' => true, 'recommendations' => true, 'weekly' => true, 'planner' => true, 'ai_narrative' => false, 'conversation_personalization' => false, 'plan_learning' => false, 'goal_reviews' => false],
        'sources' => ['calendar' => true, 'connected' => true, 'goals' => true, 'habits' => true, 'focus' => true, 'checkins' => true],
        'frequency' => 'quiet',
        'personalization' => false,
        'retention_days' => 90,
        'planning_strategy' => null,
        'conversation_reset_at' => null,
    ];

    /**
     * @return array<string, mixed>
     */
    public static function for(User $user): array
    {
        return self::merge(self::DEFAULTS, $user->preferences()['intelligence'] ?? []);
    }

    public static function feature(User $user, string $feature): bool
    {
        $s = self::for($user);

        return $s['enabled'] && ($s['features'][$feature] ?? false);
    }

    public static function source(User $user, string $source): bool
    {
        return (bool) (self::for($user)['sources'][$source] ?? false);
    }

    /**
     * @param  array<string, mixed>  $changes  already validated
     * @return array<string, mixed>
     */
    public static function save(User $user, array $changes): array
    {
        $setting = UserSetting::firstOrCreate(['user_id' => $user->id], ['preferences' => []]);
        $preferences = $setting->preferences ?? [];
        $preferences['intelligence'] = self::merge(self::merge(self::DEFAULTS, $preferences['intelligence'] ?? []), $changes);
        $setting->update(['preferences' => $preferences]);

        return $preferences['intelligence'];
    }

    /**
     * Defaults overlaid with stored values, keeping only known keys.
     *
     * @param  array<string, mixed>  $base
     * @param  array<string, mixed>  $over
     * @return array<string, mixed>
     */
    private static function merge(array $base, array $over): array
    {
        foreach ($base as $key => $value) {
            if (! array_key_exists($key, $over)) {
                continue;
            }
            $base[$key] = is_array($value) && is_array($over[$key]) ? self::merge($value, $over[$key]) : $over[$key];
        }

        return $base;
    }
}
