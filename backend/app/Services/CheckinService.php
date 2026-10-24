<?php

namespace App\Services;

use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * Self-reported check-ins and the patterns they show next to the user's own work data.
 * Statements are observational comparisons with minimum sample sizes — never medical or causal claims.
 */
class CheckinService
{
    public const MIN_DAYS_PER_GROUP = 3;

    public static function enabled(User $user): bool
    {
        return (bool) ($user->preferences()['checkins_enabled'] ?? true);
    }

    public function forDate(User $user, string $date): ?DailyCheckin
    {
        return DailyCheckin::where('user_id', $user->id)->whereDate('date', $date)->first();
    }

    /**
     * Daily rows joining check-ins with focus minutes and completed tasks (user's local dates).
     *
     * @return Collection<string, array<string, mixed>>
     */
    public function series(User $user, CarbonImmutable $from, CarbonImmutable $to): Collection
    {
        $tz = $user->timezone();
        $checkins = DailyCheckin::where('user_id', $user->id)->whereBetween('date', [$from->toDateString(), $to->toDateString()])->get()->keyBy(fn (DailyCheckin $c) => $c->date->toDateString());
        $focus = FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])->where('status', 'completed')
            ->whereBetween('completed_at', [$from->startOfDay()->utc(), $to->endOfDay()->utc()])->get(['completed_at', 'elapsed_seconds'])
            ->groupBy(fn (FocusSession $s) => $s->completed_at->setTimezone($tz)->toDateString())->map(fn ($g) => (int) floor($g->sum('elapsed_seconds') / 60));
        $done = Task::where('user_id', $user->id)->where('status', 'completed')->whereBetween('completed_at', [$from->startOfDay()->utc(), $to->endOfDay()->utc()])->get(['completed_at'])
            ->groupBy(fn (Task $t) => $t->completed_at->setTimezone($tz)->toDateString())->map->count();
        $rows = collect();
        for ($day = $from->startOfDay(); $day <= $to; $day = $day->addDay()) {
            $key = $day->toDateString();
            $c = $checkins->get($key);
            $rows->put($key, ['date' => $key, 'energy' => $c?->energy, 'mood' => $c?->mood, 'stress' => $c?->stress, 'workload' => $c?->workload, 'sleep_minutes' => $c?->sleep_minutes, 'focus_minutes' => $focus->get($key, 0), 'completed' => $done->get($key, 0), 'checked_in' => $c !== null]);
        }

        return $rows;
    }

    /**
     * @return array<string, mixed>
     */
    public function insights(User $user, int $days = 60): array
    {
        $to = CarbonImmutable::now($user->timezone())->startOfDay();
        $from = $to->subDays($days - 1);
        $rows = $this->series($user, $from, $to);
        $checked = $rows->where('checked_in', true);
        $findings = [];
        $compare = function (string $key, string $metric, callable $high, callable $low, array $labels) use ($checked, &$findings) {
            $a = $checked->filter(fn ($r) => $r[$key] !== null && $high($r[$key]));
            $b = $checked->filter(fn ($r) => $r[$key] !== null && $low($r[$key]));
            if ($a->count() < self::MIN_DAYS_PER_GROUP || $b->count() < self::MIN_DAYS_PER_GROUP) {
                return;
            }
            $avgA = round($a->avg($metric), 1);
            $avgB = round($b->avg($metric), 1);
            if (abs($avgA - $avgB) < ($metric === 'focus_minutes' ? 10 : 0.5)) {
                $findings[] = ['key' => "{$key}_{$metric}", 'type' => 'neutral', 'en' => $labels['same_en'], 'ar' => $labels['same_ar'], 'groups' => [['label' => $labels['a'], 'days' => $a->count(), 'average' => $avgA], ['label' => $labels['b'], 'days' => $b->count(), 'average' => $avgB]]];

                return;
            }
            $findings[] = ['key' => "{$key}_{$metric}", 'type' => $avgA >= $avgB ? 'positive' : 'warning',
                'en' => sprintf($labels['en'], $a->count(), $avgA, $b->count(), $avgB), 'ar' => sprintf($labels['ar'], $a->count(), $avgA, $b->count(), $avgB),
                'groups' => [['label' => $labels['a'], 'days' => $a->count(), 'average' => $avgA], ['label' => $labels['b'], 'days' => $b->count(), 'average' => $avgB]]];
        };
        $compare('energy', 'focus_minutes', fn ($v) => $v >= 4, fn ($v) => $v <= 2, ['a' => 'energy 4–5', 'b' => 'energy 1–2',
            'en' => 'On the %d days you rated your energy 4–5 you logged %s focus minutes on average, versus %d lower-energy days averaging %s.', 'ar' => 'في %d أيام قيّمت فيها طاقتك ٤–٥ سجّلت %s دقيقة تركيز في المتوسط، مقابل %d أيام منخفضة الطاقة بمتوسط %s.',
            'same_en' => 'Your focus time looks similar on higher- and lower-energy days.', 'same_ar' => 'وقت تركيزك متقارب في أيام الطاقة المرتفعة والمنخفضة.']);
        $compare('sleep_minutes', 'focus_minutes', fn ($v) => $v >= 420, fn ($v) => $v < 360, ['a' => '7h+ sleep', 'b' => 'under 6h sleep',
            'en' => 'After nights you logged 7+ hours of sleep (%d days) you focused %s minutes on average; after under 6 hours (%d days), %s.', 'ar' => 'بعد ليالٍ سجّلت فيها ٧ ساعات نوم أو أكثر (%d أيام) كان متوسط تركيزك %s دقيقة؛ وبعد أقل من ٦ ساعات (%d أيام) %s.',
            'same_en' => 'Your focus time looks similar regardless of the sleep you logged.', 'same_ar' => 'وقت تركيزك متقارب بغض النظر عن ساعات النوم المسجلة.']);
        $compare('workload', 'completed', fn ($v) => $v >= 4, fn ($v) => $v <= 2, ['a' => 'heavy workload', 'b' => 'light workload',
            'en' => 'On %d days that felt heavy you completed %s tasks on average, versus %d lighter days with %s.', 'ar' => 'في %d أيام شعرت فيها بعبء ثقيل أنجزت %s مهمة في المتوسط، مقابل %d أيام أخف بمتوسط %s.',
            'same_en' => 'You complete a similar number of tasks whether the day feels heavy or light.', 'same_ar' => 'تنجز عدداً متقارباً من المهام سواء كان اليوم ثقيلاً أو خفيفاً.']);
        $compare('stress', 'focus_minutes', fn ($v) => $v >= 4, fn ($v) => $v <= 2, ['a' => 'high stress', 'b' => 'low stress',
            'en' => 'On %d high-stress days you focused %s minutes on average, versus %d calmer days with %s.', 'ar' => 'في %d أيام شديدة التوتر كان متوسط تركيزك %s دقيقة، مقابل %d أيام أهدأ بمتوسط %s.',
            'same_en' => 'Your focus time looks similar on calm and stressful days.', 'same_ar' => 'وقت تركيزك متقارب في الأيام الهادئة والمتوترة.']);

        $recent = $checked->filter(fn ($r) => $r['date'] > $to->subDays(7)->toDateString());
        $previous = $checked->filter(fn ($r) => $r['date'] <= $to->subDays(7)->toDateString() && $r['date'] > $to->subDays(14)->toDateString());
        $avg = fn (Collection $c, string $k) => $c->whereNotNull($k)->count() >= self::MIN_DAYS_PER_GROUP ? round($c->whereNotNull($k)->avg($k), 1) : null;

        return [
            'enabled' => self::enabled($user),
            'days' => $days,
            'checked_in_days' => $checked->count(),
            'averages' => collect(DailyCheckin::SCALES)->mapWithKeys(fn ($k) => [$k => $avg($checked, $k)])->all() + ['sleep_minutes' => $avg($checked, 'sleep_minutes')],
            'trend' => ['energy' => ['last_7' => $avg($recent, 'energy'), 'previous_7' => $avg($previous, 'energy')], 'workload' => ['last_7' => $avg($recent, 'workload'), 'previous_7' => $avg($previous, 'workload')]],
            'findings' => $findings,
            'series' => $rows->values(),
            'note' => ['en' => 'These are patterns in your own entries, not medical advice. Small samples can be misleading.', 'ar' => 'هذه أنماط في إدخالاتك الشخصية وليست نصيحة طبية. قد تكون العينات الصغيرة مضللة.'],
        ];
    }
}
