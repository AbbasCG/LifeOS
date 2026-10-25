<?php

namespace App\Services;

use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;

/**
 * Opt-in learning of which plan versions a user prefers. Only small observations are stored (in user_settings, never
 * sent to an AI provider): which option of a few fixed choices was picked, on which date, and the situation it was
 * picked in (a workday or a day off; a light, normal or heavy period). They are recorded when the user picks an
 * alternative, changes a plan by follow-up, or applies a plan.
 *
 * Recent choices count more: an observation's weight halves every HALF_LIFE_DAYS, and observations older than
 * MAX_AGE_DAYS are dropped. A preference is used once its option was chosen at least MIN_COUNT times and holds at
 * least MIN_SHARE of the weight. The situation is tried first (what the user picks on days off, or in heavy weeks),
 * then all observations. Anything the user states explicitly still wins. Resettable (all or per choice) and deleted
 * with "Delete AI data".
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

    /** A preference is used once it has at least this many observations and this share of the (recency-weighted) total. */
    public const MIN_COUNT = 3;

    public const MIN_SHARE = 0.6;

    /** An observation counts half after this many days, a quarter after twice as many. */
    public const HALF_LIFE_DAYS = 30;

    /** Observations older than this are forgotten. */
    public const MAX_AGE_DAYS = 180;

    /** At most this many observations are kept (the newest). */
    public const MAX_OBSERVATIONS = 300;

    /** Booked share of working hours below which a period is light, and from which it is heavy. */
    public const LIGHT_BELOW = 35;

    public const HEAVY_FROM = 70;

    /** Situations, in the order they are tried before falling back to all observations. */
    public const SCOPES = ['day_off', 'workday', 'light', 'normal', 'heavy'];

    private const KEY = 'plan_learning';

    public static function enabled(User $user): bool
    {
        return IntelligenceSettings::feature($user, self::FEATURE);
    }

    /**
     * The situation a planning request is in: whether its one day is a workday or a day off, and how much of its
     * working hours are already booked. Week plans only have a load. Empty when learning is off.
     *
     * @param  array<string, mixed>  $slots
     * @return array{day?: string, load?: string}
     */
    public static function context(User $user, string $intent, array $slots): array
    {
        if (! self::enabled($user)) {
            return [];
        }
        $planning = app(PlanningService::class);
        $c = $planning->config($user);
        $today = CarbonImmutable::now($c['tz'])->startOfDay();
        [$first, $days] = match ($intent) {
            'plan_week', 'prioritize' => [($slots['next_week'] ?? false) ? $today->next(CarbonImmutable::MONDAY) : $today, 7],
            'focus_blocks' => match ($slots['within'] ?? 'week') {
                'today' => [$today, 1], 'tomorrow' => [$today->addDay(), 1], default => [$today, 7],
            },
            'reorganize_day' => [is_string($slots['date'] ?? null) ? CarbonImmutable::parse($slots['date'], $c['tz'])->startOfDay() : $today, 1],
            default => [null, 0],
        };
        if ($first === null) {
            return [];
        }
        $context = [];
        if ($days === 1) {
            $context['day'] = in_array($first->dayOfWeek, $c['work_days'], true) ? 'workday' : 'day_off';
        }
        $summary = collect($planning->summary($user, $first, $days, [], [], $c)['days']);
        $capacity = (int) $summary->sum('capacity_minutes');
        if ($capacity > 0) {
            $booked = (int) round(($summary->sum('fixed_minutes') + $summary->sum('existing_flexible_minutes')) / $capacity * 100);
            $context['load'] = $booked < self::LIGHT_BELOW ? 'light' : ($booked >= self::HEAVY_FROM ? 'heavy' : 'normal');
        }

        return $context;
    }

    /**
     * @param  array{day?: string, load?: string}  $context
     */
    public static function record(User $user, string $dimension, string $value, array $context = []): void
    {
        if (! self::enabled($user) || ! in_array($value, self::DIMENSIONS[$dimension] ?? [], true)) {
            return;
        }
        $setting = UserSetting::firstOrCreate(['user_id' => $user->id], ['preferences' => []]);
        $preferences = $setting->preferences ?? [];
        $observations = self::observationsFrom($preferences[self::KEY] ?? []);
        $observations[] = ['d' => $dimension, 'v' => $value, 'at' => CarbonImmutable::now($user->timezone())->toDateString()]
            + array_filter(['day' => in_array($context['day'] ?? null, ['workday', 'day_off'], true) ? $context['day'] : null,
                'load' => in_array($context['load'] ?? null, ['light', 'normal', 'heavy'], true) ? $context['load'] : null]);
        $preferences[self::KEY] = ['observations' => array_slice($observations, -self::MAX_OBSERVATIONS)];
        $setting->update(['preferences' => $preferences]);
    }

    /**
     * Record what a planning state says the user chose (intent + slots), e.g. when they apply that plan. The state
     * carries the situation it was planned in.
     *
     * @param  array<string, mixed>  $state
     */
    public static function recordState(User $user, array $state): void
    {
        $slots = $state['slots'] ?? [];
        $context = (array) ($state['learning_context'] ?? []);
        match ($state['intent'] ?? null) {
            'plan_week', 'prioritize' => self::record($user, 'week_version', (string) ($slots['alternative'] ?? 'balanced'), $context),
            'focus_blocks' => self::record($user, 'focus_length', (string) ($slots['alternative'] ?? 'default'), $context),
            'reorganize_day' => self::record($user, 'day_strategy', (string) ($slots['variant'] ?? ''), $context),
            default => null,
        };
        if (in_array($state['intent'] ?? null, ['plan_week', 'prioritize', 'reorganize_day'], true) && array_key_exists('moves', $slots)) {
            self::record($user, 'moves', $slots['moves'] ? 'on' : 'off', $context);
        }
    }

    /**
     * The learned default for a dimension in a situation, with the situation it was learned for (null scope: from all
     * observations), or null while there is no clear preference (or learning is off).
     *
     * @param  array{day?: string, load?: string}  $context
     * @return array{value: string, scope: string|null}|null
     */
    public static function preferred(User $user, string $dimension, array $context = []): ?array
    {
        if (! self::enabled($user)) {
            return null;
        }
        $observations = collect(self::observations($user))->where('d', $dimension);
        foreach (array_filter([$context['day'] ?? null, $context['load'] ?? null]) as $scope) {
            $facet = in_array($scope, ['workday', 'day_off'], true) ? 'day' : 'load';
            if (($value = self::winner($observations->where($facet, $scope)->all())) !== null) {
                return ['value' => $value, 'scope' => $scope];
            }
        }
        $value = self::winner($observations->all());

        return $value === null ? null : ['value' => $value, 'scope' => null];
    }

    /**
     * The option with at least MIN_COUNT observations and MIN_SHARE of the recency weight, if any.
     *
     * @param  array<int, array<string, mixed>>  $observations
     */
    private static function winner(array $observations): ?string
    {
        $weights = self::weights($observations);
        $total = array_sum($weights);
        if ($total <= 0) {
            return null;
        }
        arsort($weights);
        $top = (string) array_key_first($weights);
        $count = collect($observations)->where('v', $top)->count();

        return $count >= self::MIN_COUNT && $weights[$top] / $total >= self::MIN_SHARE ? $top : null;
    }

    /**
     * Recency-weighted totals per option.
     *
     * @param  array<int, array<string, mixed>>  $observations
     * @return array<string, float>
     */
    private static function weights(array $observations): array
    {
        $today = CarbonImmutable::today();
        $weights = [];
        foreach ($observations as $o) {
            $age = max(0, (int) CarbonImmutable::parse($o['at'])->diffInDays($today, false));
            $weights[$o['v']] = ($weights[$o['v']] ?? 0) + 0.5 ** ($age / self::HALF_LIFE_DAYS);
        }

        return $weights;
    }

    /**
     * Valid, unexpired observations, oldest first.
     *
     * @return list<array{d: string, v: string, at: string, day?: string, load?: string}>
     */
    public static function observations(User $user): array
    {
        return self::observationsFrom(UserSetting::where('user_id', $user->id)->value('preferences')[self::KEY] ?? []);
    }

    /**
     * Read stored learning. V14 stored plain counts per option; those are read as undated observations from today
     * (so they start to fade from now) and are rewritten in the new form on the next change.
     *
     * @param  array<string, mixed>  $stored
     * @return list<array{d: string, v: string, at: string, day?: string, load?: string}>
     */
    private static function observationsFrom(array $stored): array
    {
        $cutoff = CarbonImmutable::today()->subDays(self::MAX_AGE_DAYS)->toDateString();
        if (! array_key_exists('observations', $stored)) {
            $today = CarbonImmutable::today()->toDateString();
            $legacy = [];
            foreach (self::DIMENSIONS as $dimension => $options) {
                foreach ($options as $option) {
                    for ($i = 0, $n = min(50, (int) ($stored[$dimension][$option] ?? 0)); $i < $n; $i++) {
                        $legacy[] = ['d' => $dimension, 'v' => $option, 'at' => $today];
                    }
                }
            }

            return $legacy;
        }

        return array_values(array_filter((array) $stored['observations'], fn ($o) => is_array($o) && in_array($o['v'] ?? null, self::DIMENSIONS[$o['d'] ?? ''] ?? [], true)
            && is_string($o['at'] ?? null) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $o['at']) && $o['at'] >= $cutoff));
    }

    /**
     * Number of observations per option.
     *
     * @return array<string, array<string, int>>
     */
    public static function counts(User $user): array
    {
        $observations = collect(self::observations($user));

        return collect(self::DIMENSIONS)->map(fn (array $options, string $d) => array_intersect_key($observations->where('d', $d)->countBy('v')->all(), array_flip($options)))->filter()->all();
    }

    /**
     * What has been learned, for the AI Control Center: counts, recency-weighted shares, the overall default and the
     * defaults learned for particular situations.
     *
     * @return list<array{dimension: string, counts: array<string, int>, total: int, shares: array<string, int>, preferred: string|null, contexts: list<array{scope: string, preferred: string}>}>
     */
    public static function summary(User $user): array
    {
        $observations = collect(self::observations($user));

        return collect(self::counts($user))->map(function (array $counts, string $d) use ($observations) {
            $mine = $observations->where('d', $d);
            $weights = self::weights($mine->all());
            $total = array_sum($weights) ?: 1;
            $overall = self::winner($mine->all());
            $contexts = [];
            foreach (self::SCOPES as $scope) {
                $value = self::winner($mine->where(in_array($scope, ['workday', 'day_off'], true) ? 'day' : 'load', $scope)->all());
                if ($value !== null && $value !== $overall) {
                    $contexts[] = ['scope' => $scope, 'preferred' => $value];
                }
            }

            return ['dimension' => $d, 'counts' => $counts, 'total' => array_sum($counts), 'shares' => array_map(fn ($w) => (int) round($w / $total * 100), $weights),
                'preferred' => $overall, 'contexts' => $contexts];
        })->values()->all();
    }

    /**
     * Forget everything learned, or one choice only. Returns the number of observations removed.
     */
    public static function reset(User $user, ?string $dimension = null): int
    {
        $setting = UserSetting::where('user_id', $user->id)->first();
        $preferences = $setting?->preferences ?? [];
        if (! $setting || ! isset($preferences[self::KEY])) {
            return 0;
        }
        $observations = self::observationsFrom($preferences[self::KEY]);
        $kept = $dimension === null ? [] : array_values(array_filter($observations, fn (array $o) => $o['d'] !== $dimension));
        if ($kept === []) {
            unset($preferences[self::KEY]);
        } else {
            $preferences[self::KEY] = ['observations' => $kept];
        }
        $setting->update(['preferences' => $preferences]);

        return count($observations) - count($kept);
    }
}
