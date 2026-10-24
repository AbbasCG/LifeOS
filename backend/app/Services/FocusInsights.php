<?php

namespace App\Services;

use App\Models\FocusSession;
use App\Models\User;
use Carbon\CarbonImmutable;

/**
 * Focus performance from the user's own sessions: volume, consistency, completion, depth, distractions and timing.
 */
class FocusInsights
{
    /**
     * @return array<string, mixed>
     */
    public function summary(User $user, int $days = 30): array
    {
        $tz = $user->timezone();
        $today = CarbonImmutable::now($tz)->startOfDay();
        $from = $today->subDays($days - 1);
        $sessions = FocusSession::where('user_id', $user->id)->whereIn('kind', ['focus', 'manual'])
            ->where(fn ($q) => $q->where('completed_at', '>=', $from->utc())->orWhere(fn ($q) => $q->where('status', 'cancelled')->where('created_at', '>=', $from->utc())))
            ->with('project:id,title,color')->get();
        $done = $sessions->where('status', 'completed');
        $timed = $sessions->where('kind', 'focus');
        $minutes = (int) floor($done->sum('elapsed_seconds') / 60);
        $local = fn (FocusSession $s) => ($s->completed_at ?? $s->created_at)->setTimezone($tz);
        $byDay = $done->groupBy(fn (FocusSession $s) => $local($s)->toDateString())->map(fn ($g) => (int) floor($g->sum('elapsed_seconds') / 60));
        $byHour = array_fill(0, 24, 0);
        foreach ($done as $s) {
            $start = ($s->started_at ?? $s->completed_at->subSeconds($s->elapsed_seconds))->setTimezone($tz);
            $byHour[$start->hour] += (int) floor($s->elapsed_seconds / 60);
        }
        $streak = 0;
        for ($d = $byDay->has($today->toDateString()) ? $today : $today->subDay(); $byDay->has($d->toDateString()); $d = $d->subDay()) {
            $streak++;
        }
        $interruptions = $done->flatMap(fn (FocusSession $s) => $s->interruptions ?? []);
        $deepMinutes = (int) floor($done->filter(fn (FocusSession $s) => $s->mode === 'deep' || $s->elapsed_seconds >= 50 * 60)->sum('elapsed_seconds') / 60);
        $completedTimed = $timed->where('status', 'completed')->count();
        $cancelledTimed = $timed->where('status', 'cancelled')->count();
        $planned = (int) floor($timed->where('status', 'completed')->sum('duration_seconds') / 60);
        $actual = (int) floor($timed->where('status', 'completed')->sum('elapsed_seconds') / 60);
        $hours = max(1 / 60, $minutes / 60);
        $topReason = $interruptions->countBy('reason')->sortDesc()->keys()->first();
        $bestHour = $minutes > 0 ? array_search(max($byHour), $byHour, true) : null;
        $weekday = $done->groupBy(fn (FocusSession $s) => $local($s)->dayOfWeek)->map(fn ($g) => (int) floor($g->sum('elapsed_seconds') / 60))->sortDesc();
        $cleanSessions = $done->filter(fn (FocusSession $s) => empty($s->interruptions) && $s->kind === 'focus')->pluck('elapsed_seconds')->sort()->values();
        $typical = $cleanSessions->count() >= 3 ? (int) round($cleanSessions[intdiv($cleanSessions->count(), 2)] / 60) : null;

        $tips = [];
        if ($done->count() >= 5 && $interruptions->count() / $hours >= 1.5 && $topReason) {
            $tips[] = ['en' => sprintf('You log about %.1f distractions per focus hour, most often “%s”. Try silencing that source before starting.', $interruptions->count() / $hours, $topReason), 'ar' => sprintf('تسجّل نحو %.1f مقاطعة لكل ساعة تركيز، وأكثرها «%s». جرّب إسكات هذا المصدر قبل البدء.', $interruptions->count() / $hours, $topReason)];
        }
        if ($bestHour !== null && $done->count() >= 5) {
            $tips[] = ['en' => sprintf('Most of your focus happens around %02d:00. Protect that hour for important work.', $bestHour), 'ar' => sprintf('معظم تركيزك يكون حوالي الساعة %02d:00. احمِ هذه الساعة للعمل المهم.', $bestHour)];
        }
        if ($completedTimed + $cancelledTimed >= 5 && $cancelledTimed / ($completedTimed + $cancelledTimed) > 0.25) {
            $tips[] = ['en' => 'More than a quarter of your timed sessions were stopped early. Shorter sessions may be easier to finish.', 'ar' => 'أكثر من ربع جلساتك المؤقتة توقفت مبكراً. قد تكون الجلسات الأقصر أسهل في الإكمال.'];
        }
        if ($typical !== null) {
            $tips[] = ['en' => "Your uninterrupted sessions typically last {$typical} minutes — a good default length for you.", 'ar' => "تستمر جلساتك دون مقاطعة عادةً {$typical} دقيقة — مدة افتراضية مناسبة لك."];
        }

        return [
            'days' => $days,
            'sessions' => $done->count(),
            'minutes' => $minutes,
            'average_minutes' => $done->count() ? (int) round($minutes / $done->count()) : 0,
            'deep_minutes' => $deepMinutes,
            'completion_rate' => $completedTimed + $cancelledTimed ? (int) round($completedTimed / ($completedTimed + $cancelledTimed) * 100) : null,
            'planned_minutes' => $planned,
            'actual_minutes' => $actual,
            'focus_days' => $byDay->count(),
            'consistency' => (int) round($byDay->count() / $days * 100),
            'streak_days' => $streak,
            'interruptions' => $interruptions->count(),
            'interruptions_per_hour' => $minutes > 0 ? round($interruptions->count() / $hours, 1) : 0,
            'distractions' => $interruptions->countBy('reason')->sortDesc()->map(fn ($n, $reason) => ['reason' => $reason, 'count' => $n])->values(),
            'best_hour' => $bestHour,
            'best_weekday' => $weekday->keys()->first(),
            'typical_minutes' => $typical,
            'by_hour' => $byHour,
            'by_day' => collect(range($days - 1, 0))->map(fn ($d) => ['date' => $today->subDays($d)->toDateString(), 'minutes' => $byDay->get($today->subDays($d)->toDateString(), 0)])->values(),
            'by_project' => $done->groupBy(fn (FocusSession $s) => $s->project_id ?? 0)->map(fn ($g, $pid) => ['project_id' => $pid ?: null, 'title' => $g->first()->project?->title, 'color' => $g->first()->project?->color, 'minutes' => (int) floor($g->sum('elapsed_seconds') / 60)])->sortByDesc('minutes')->values(),
            'tips' => $tips,
        ];
    }
}
