<?php

namespace App\Services;

use App\Models\User;
use Carbon\CarbonImmutable;

/**
 * The morning intelligence briefing on Today: top priorities, what is coming up, where focus fits, overloaded periods,
 * unfinished work and a few improvements — every item with its confidence and the data it came from.
 */
class MorningIntelligence
{
    public function __construct(private IntelligenceService $intelligence, private RecommendationService $recommendations) {}

    /**
     * @return array<string, mixed>
     */
    public function briefing(User $user): array
    {
        if (! IntelligenceSettings::feature($user, 'briefing')) {
            return ['enabled' => false];
        }
        $snap = $this->intelligence->snapshot($user);
        $tz = $snap['timezone'];
        $now = CarbonImmutable::now($tz);
        $endOfDay = $now->startOfDay()->addDay();
        $meetings = collect($snap['occurrences'])->filter(fn (array $o) => $o['ends_at'] > $now->utc() && $o['starts_at'] < $endOfDay->utc() && ! ($o['all_day'] ?? false)
            && (($o['source'] ?? 'lifeos') !== 'lifeos' || ($o['kind'] ?? '') === 'fixed'))
            ->take(6)->map(fn (array $o) => ['title' => $o['title'], 'starts_at' => $o['starts_at']->toIso8601String(), 'ends_at' => $o['ends_at']->toIso8601String(), 'source' => $o['source'] ?? 'lifeos'])->values();
        $deadlines = $snap['priorities']->filter(fn (array $p) => $p['due_at'] && CarbonImmutable::parse($p['due_at'])->lte($now->addHours(48)))->take(5)->values();
        $overloaded = $snap['workload']->filter(fn (array $d) => $d['work_day'] && $d['overloaded'])->values();
        $capacity = $snap['focus_capacity'];
        $mustMinutes = (int) $snap['priorities']->filter(fn (array $p) => $p['risk'] === 'high' && ! $p['scheduled'])->sum('estimated_minutes');

        $improvements = [];
        if ($mustMinutes > $capacity['minutes'] && $capacity['minutes'] > 0) {
            $improvements[] = ['key' => 'capacity', 'en' => "Urgent work needs about {$mustMinutes} min, but about {$capacity['minutes']} min of focus fits today. Decide now what moves.", 'ar' => "يحتاج العمل العاجل نحو {$mustMinutes} دقيقة، ويتسع اليوم لنحو {$capacity['minutes']} دقيقة تركيز. قرر الآن ما يُنقل.", 'sources' => ['tasks', 'calendar']];
        }
        if ($snap['focus_windows']->isNotEmpty() && ! $snap['focus_windows']->contains(fn ($w) => $w['minutes'] >= 60)) {
            $improvements[] = ['key' => 'fragmented', 'en' => 'Today has no free hour in one piece. Protect one block for deep work.', 'ar' => 'لا توجد ساعة متاحة متصلة اليوم. احمِ فترة واحدة للعمل العميق.', 'sources' => ['calendar']];
        }
        foreach ($snap['habits']->where('at_risk', true)->take(1) as $h) {
            $improvements[] = ['key' => "habit:{$h['id']}", 'en' => "Keep your {$h['current_streak']}-day “{$h['title']}” streak alive today.", 'ar' => "حافظ على سلسلة «{$h['title']}» ({$h['current_streak']} أيام) اليوم.", 'sources' => ['habits']];
        }
        if ($snap['unfinished']->isNotEmpty()) {
            $u = $snap['unfinished']->first();
            $improvements[] = ['key' => "unfinished:{$u['id']}", 'en' => "“{$u['title']}” has been in progress without changes for {$u['idle_days']} days. Finish, split or pause it.", 'ar' => "«{$u['title']}» قيد التنفيذ دون تغيير منذ {$u['idle_days']} أيام. أنهِها أو قسّمها أو أوقفها.", 'sources' => ['tasks']];
        }

        return [
            'enabled' => true,
            'generated_at' => $snap['generated_at'], 'date' => $snap['date'], 'timezone' => $tz, 'sources' => $snap['sources'],
            'priorities' => $snap['priorities']->take(3)->values(),
            'meetings' => $meetings,
            'deadlines' => $deadlines,
            'focus' => ['windows' => $snap['focus_windows']->take(4)->values(), 'capacity' => $capacity],
            'overloaded' => $overloaded,
            'unfinished' => $snap['unfinished']->concat($snap['postponed']->map(fn ($p) => $p + ['postponed' => true]))->unique('id')->take(4)->values(),
            'improvements' => array_slice($improvements, 0, 3),
            'suggestions' => $this->recommendations->current($user)->take(3)->map->present()->values(),
        ];
    }
}
