<?php

namespace App\Services;

use App\Models\User;
use App\Models\UserSetting;

/**
 * Opt-in learning of which plan versions a user prefers. Only counts are stored (in user_settings, never sent to an
 * AI provider): one counter per option of a few fixed choices, raised when the user picks an alternative, changes a
 * plan by follow-up, or applies a plan. Once one option clearly wins it becomes the default for a fresh request;
 * anything the user states explicitly still wins. Resettable and deleted with "Delete AI data".
 */
class PlanLearning
{
    public const FEATURE = 'plan_learning';

    /** @var array<string, list<string>> */
    public const DIMENSIONS = [
        'week_version' => ['balanced', 'essentials'],
        'focus_length' => ['short', 'default', 'long'],
        'day_strategy' => DayPlanner::VARIANTS,
        'moves' => ['on', 'off'],
    ];

    /** A preference is used once it has at least this many observations and this share of them. */
    public const MIN_COUNT = 3;

    public const MIN_SHARE = 0.6;

    private const KEY = 'plan_learning';

    public static function enabled(User $user): bool
    {
        return IntelligenceSettings::feature($user, self::FEATURE);
    }

    public static function record(User $user, string $dimension, string $value): void
    {
        if (! self::enabled($user) || ! in_array($value, self::DIMENSIONS[$dimension] ?? [], true)) {
            return;
        }
        $setting = UserSetting::firstOrCreate(['user_id' => $user->id], ['preferences' => []]);
        $preferences = $setting->preferences ?? [];
        $preferences[self::KEY][$dimension][$value] = (int) ($preferences[self::KEY][$dimension][$value] ?? 0) + 1;
        $setting->update(['preferences' => $preferences]);
    }

    /**
     * Record what a planning state says the user chose (intent + slots), e.g. when they apply that plan.
     *
     * @param  array<string, mixed>  $state
     */
    public static function recordState(User $user, array $state): void
    {
        $slots = $state['slots'] ?? [];
        match ($state['intent'] ?? null) {
            'plan_week', 'prioritize' => self::record($user, 'week_version', (string) ($slots['alternative'] ?? 'balanced')),
            'focus_blocks' => self::record($user, 'focus_length', (string) ($slots['alternative'] ?? 'default')),
            'reorganize_day' => self::record($user, 'day_strategy', (string) ($slots['variant'] ?? '')),
            default => null,
        };
        if (in_array($state['intent'] ?? null, ['plan_week', 'prioritize', 'reorganize_day'], true) && array_key_exists('moves', $slots)) {
            self::record($user, 'moves', $slots['moves'] ? 'on' : 'off');
        }
    }

    /**
     * The learned default for a dimension, or null while there is no clear preference (or learning is off).
     */
    public static function preferred(User $user, string $dimension): ?string
    {
        if (! self::enabled($user)) {
            return null;
        }
        $counts = self::counts($user)[$dimension] ?? [];
        $total = array_sum($counts);
        if ($total < self::MIN_COUNT) {
            return null;
        }
        arsort($counts);
        $top = (string) array_key_first($counts);

        return $counts[$top] >= self::MIN_COUNT && $counts[$top] / $total >= self::MIN_SHARE ? $top : null;
    }

    /**
     * @return array<string, array<string, int>>
     */
    public static function counts(User $user): array
    {
        $stored = UserSetting::where('user_id', $user->id)->value('preferences')[self::KEY] ?? [];

        return collect(self::DIMENSIONS)->map(fn (array $options, string $d) => array_intersect_key(array_map('intval', (array) ($stored[$d] ?? [])), array_flip($options)))->filter()->all();
    }

    /**
     * What has been learned, for the AI Control Center.
     *
     * @return list<array{dimension: string, counts: array<string, int>, total: int, preferred: string|null}>
     */
    public static function summary(User $user): array
    {
        return collect(self::counts($user))->map(fn (array $counts, string $d) => ['dimension' => $d, 'counts' => $counts, 'total' => array_sum($counts), 'preferred' => self::preferred($user, $d)])->values()->all();
    }

    public static function reset(User $user): int
    {
        $setting = UserSetting::where('user_id', $user->id)->first();
        $preferences = $setting?->preferences ?? [];
        $cleared = (int) collect($preferences[self::KEY] ?? [])->flatten()->sum();
        if ($setting && isset($preferences[self::KEY])) {
            unset($preferences[self::KEY]);
            $setting->update(['preferences' => $preferences]);
        }

        return $cleared;
    }
}
