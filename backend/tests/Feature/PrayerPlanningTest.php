<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\PlanningService;
use App\Services\PrayerTimes;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Prayer windows are soft. Planners and suggestions keep clear of them (and the numbers they show leave them out); an explicit booking
 * over a prayer is never refused, and the booking and conflict contracts are the ones every other test covers.
 *
 * The user is in Makkah but on the UTC clock, so on Wednesday 2027-02-03 (not Ramadan) the windows fall inside the 09:00-17:00 work day:
 * Dhuhr ~09:20, Asr ~12:35, Maghrib ~15:15, Isha ~16:45 UTC, each with 10 minutes before and 20 after.
 */
class PrayerPlanningTest extends TestCase
{
    use RefreshDatabase;

    private const DAY = '2027-02-03';

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'buffer_minutes' => 10, 'focus_block_minutes' => 60]]);
        $this->actingAs($this->user);
    }

    /** @param array<string, mixed> $extra */
    private function prayerOn(array $extra = []): void
    {
        $this->setPrefs(['prayer_enabled' => true, 'prayer_lat' => 21.4225, 'prayer_lng' => 39.8262] + $extra);
    }

    /** @param array<string, mixed> $prefs */
    private function setPrefs(array $prefs): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->preferences(), $prefs)]);
    }

    /** @return list<array{0: CarbonImmutable, 1: CarbonImmutable}> the protected spans of the day, whatever the settings are right now */
    private function windows(string $day = self::DAY): array
    {
        $prayer = PrayerTimes::for($this->user->fresh());

        return $prayer->protectedWindows($day);
    }

    /** Minutes of the 09:00-17:00 work day taken by the day's prayer windows (the Isha window runs past 17:00, so this is a little under 120). */
    private function protectedInWorkDay(): int
    {
        $from = CarbonImmutable::parse(self::DAY.' 09:00', 'UTC');
        $to = CarbonImmutable::parse(self::DAY.' 17:00', 'UTC');

        return (int) (collect($this->windows())->sum(fn (array $w) => max(0, min($w[1]->getTimestamp(), $to->getTimestamp()) - max($w[0]->getTimestamp(), $from->getTimestamp()))) / 60);
    }

    /** @param array{starts_at: string, ends_at: string} $item */
    private function touchesAWindow(array $item): bool
    {
        $s = CarbonImmutable::parse($item['starts_at']);
        $e = CarbonImmutable::parse($item['ends_at']);

        return collect($this->windows())->contains(fn (array $w) => $s < $w[1] && $e > $w[0]);
    }

    private function dhuhrWindow(): array
    {
        return collect(PrayerTimes::for($this->user->fresh())->windows(self::DAY))->firstWhere('prayer', 'dhuhr');
    }

    public function test_the_precondition_prayer_windows_sit_inside_the_work_day(): void
    {
        $this->prayerOn();
        $windows = $this->windows();
        $this->assertCount(5, $windows);
        $inside = collect($windows)->filter(fn (array $w) => $w[0] >= CarbonImmutable::parse(self::DAY.' 09:00') && $w[1] <= CarbonImmutable::parse(self::DAY.' 17:30'));
        $this->assertGreaterThanOrEqual(4, $inside->count());
    }

    public function test_the_week_planner_never_proposes_a_block_inside_a_window(): void
    {
        foreach (['Report' => 150, 'Slides' => 120, 'Review' => 90, 'Email' => 60] as $title => $minutes) {
            Task::create(['user_id' => $this->user->id, 'title' => $title, 'estimated_minutes' => $minutes, 'priority' => 'high']);
        }
        $before = $this->postJson('/api/plans', ['date' => self::DAY, 'days' => 1])->assertCreated()->json('items');
        $this->assertTrue(collect($before)->contains(fn ($i) => $this->touchesAWindowAt($i)), 'without prayer times the same plan does cross prayer times (precondition)');

        $this->prayerOn();
        $plan = $this->postJson('/api/plans', ['date' => self::DAY, 'days' => 1])->assertCreated()->json();
        $this->assertNotEmpty($plan['items']);
        foreach ($plan['items'] as $item) {
            $this->assertFalse($this->touchesAWindow($item), "{$item['title']} {$item['starts_at']} avoids the prayer windows");
        }
        $day = $plan['summary']['days'][0];
        $this->prayerOn();
        $this->assertSame($this->protectedInWorkDay(), $day['protected_minutes']);
        $this->assertSame(480 - $this->protectedInWorkDay(), $day['capacity_minutes']);
    }

    /** The same check as touchesAWindow but for the unprotected baseline: the windows the user WOULD have if prayer times were on. */
    private function touchesAWindowAt(array $item): bool
    {
        $was = $this->user->fresh()->preferences();
        $this->prayerOn();
        $touches = $this->touchesAWindow($item);
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => $was]);

        return $touches;
    }

    public function test_the_day_planner_and_its_budget_leave_the_windows_out(): void
    {
        Task::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'estimated_minutes' => 240, 'priority' => 'high']);
        $off = $this->getJson('/api/day-plan?date='.self::DAY)->assertOk()->json();
        $this->assertSame(480, $off['budget']['free_minutes']);

        $this->prayerOn();
        $on = $this->getJson('/api/day-plan?date='.self::DAY)->assertOk()->json();
        $this->assertSame(480 - $this->protectedInWorkDay(), $on['budget']['free_minutes']);
        foreach ($on['alternatives'] as $alternative) {
            foreach ($alternative['items'] as $item) {
                $this->assertFalse($this->touchesAWindow($item), "{$alternative['key']}: {$item['starts_at']}");
            }
        }
    }

    public function test_availability_today_and_the_briefing_do_not_offer_prayer_time_as_free(): void
    {
        $this->prayerOn();
        $day = $this->getJson('/api/availability?date='.self::DAY)->assertOk()->json('days.0');
        $this->assertSame(480 - $this->protectedInWorkDay(), $day['free_minutes']);
        foreach ($day['slots'] as $slot) {
            $this->assertFalse($this->touchesAWindow($slot));
        }

        $this->travelTo(CarbonImmutable::parse(self::DAY.' 08:00', 'UTC'));
        $this->getJson('/api/briefing')->assertOk()->assertJsonPath('stats.available_minutes', 480 - $this->protectedInWorkDay());
        $slots = $this->getJson('/api/today')->assertOk()->json('focus_time.slots');
        $this->assertNotEmpty($slots);
        foreach ($slots as $slot) {
            $this->assertFalse($this->touchesAWindow($slot));
        }

        $this->setPrefs(['prayer_enabled' => false]);
        $this->getJson('/api/availability?date='.self::DAY)->assertOk()->assertJsonPath('days.0.free_minutes', 480);
        $this->getJson('/api/briefing')->assertOk()->assertJsonPath('stats.available_minutes', 480);
    }

    public function test_the_deadline_check_counts_less_free_time_when_prayer_times_are_on(): void
    {
        $this->travelTo(CarbonImmutable::parse(self::DAY.' 08:00', 'UTC'));
        // 7 hours of work due at the end of the day: it fits into the 8 working hours, but not into the 6 that remain after the prayers.
        Task::create(['user_id' => $this->user->id, 'title' => 'Big report', 'estimated_minutes' => 420, 'due_at' => self::DAY.'T17:00:00Z']);
        $planning = app(PlanningService::class);
        $this->assertSame(480, $planning->summary($this->user, CarbonImmutable::parse(self::DAY), 1, [], [])['days'][0]['free_minutes']);
        $this->prayerOn();
        $this->assertSame(480 - $this->protectedInWorkDay(), $planning->summary($this->user->fresh(), CarbonImmutable::parse(self::DAY), 1, [], [])['days'][0]['free_minutes']);
    }

    public function test_copilot_focus_blocks_avoid_the_windows(): void
    {
        Task::create(['user_id' => $this->user->id, 'title' => 'Write', 'estimated_minutes' => 300, 'priority' => 'high']);
        $this->prayerOn();
        $r = $this->postJson('/api/copilot/messages', ['message' => 'Find three focus blocks this week', 'language' => 'en'])->assertOk()
            ->assertJsonPath('message.intent', 'focus_blocks');
        $actions = $r->json('message.proposal.actions');
        $this->assertNotEmpty($actions);
        foreach ($actions as $action) {
            $this->assertFalse(collect(PrayerTimes::for($this->user->fresh())->protectedIntervals(CarbonImmutable::parse($action['starts_at']), CarbonImmutable::parse($action['ends_at'])))->isNotEmpty(), 'focus block '.$action['starts_at']);
        }
    }

    public function test_the_suggestion_after_a_conflict_skips_the_window_while_the_booking_itself_is_never_refused_for_a_prayer(): void
    {
        $dhuhr = $this->dhuhrWindowIfOn();
        // The morning is booked up to 5 minutes before the Dhuhr window, so the next 30 minutes would start inside it.
        $busyUntil = $dhuhr['starts_at']->subMinutes(5);
        $this->assertGreaterThan(CarbonImmutable::parse(self::DAY.' 09:05'), $busyUntil);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'kind' => 'fixed', 'starts_at' => self::DAY.' 09:00:00', 'ends_at' => $busyUntil->format('Y-m-d H:i:s')]);
        $clash = ['title' => 'Clash', 'kind' => 'fixed', 'starts_at' => self::DAY.'T09:00:00Z', 'ends_at' => self::DAY.'T09:30:00Z'];

        // With prayer times off the suggestion is the minute the workshop ends (the behaviour every other test pins down).
        $this->setPrefs(['prayer_enabled' => false]);
        $plain = $this->postJson('/api/events', $clash)->assertUnprocessable()->json('conflict');
        $this->assertSame($busyUntil->format('Y-m-d\TH:i:s\Z'), $plain['suggestion']['starts_at']);

        // With them on it starts after the window and is itself outside every window.
        $this->prayerOn();
        $conflict = $this->postJson('/api/events', $clash)->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict')->json('conflict');
        $this->assertCount(1, $conflict['conflicts'], 'the clash lists real events only, never a prayer');
        $this->assertGreaterThanOrEqual($dhuhr['ends_at']->getTimestamp(), CarbonImmutable::parse($conflict['suggestion']['starts_at'])->getTimestamp());
        $this->assertFalse($this->touchesAWindow($conflict['suggestion']));

        // An explicit booking right over the prayer is accepted: events and task sessions.
        $inside = ['starts_at' => $dhuhr['starts_at']->addMinutes(12)->format('Y-m-d\TH:i:s\Z'), 'ends_at' => $dhuhr['starts_at']->addMinutes(18)->format('Y-m-d\TH:i:s\Z')];
        $this->postJson('/api/events', ['title' => 'During Dhuhr', 'kind' => 'fixed'] + $inside)->assertCreated();
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Session over Asr', 'estimated_minutes' => 30]);
        $asr = collect(PrayerTimes::for($this->user->fresh())->windows(self::DAY))->firstWhere('prayer', 'asr');
        $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => $asr['starts_at']->addMinutes(10)->format('Y-m-d\TH:i:s\Z'), 'ends_at' => $asr['starts_at']->addMinutes(40)->format('Y-m-d\TH:i:s\Z')])->assertCreated();
        $this->assertDatabaseHas('calendar_events', ['title' => 'During Dhuhr']);
    }

    private function dhuhrWindowIfOn(): array
    {
        $this->prayerOn();

        return $this->dhuhrWindow();
    }

    public function test_an_assistant_schedule_proposal_avoids_the_windows(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-02-02 08:00', 'UTC'));
        $ask = fn () => $this->postJson('/api/assistant', ['message' => 'I have four hours available tomorrow. Schedule studying, programming, and exercise.', 'language' => 'en'])
            ->assertOk()->assertJsonPath('intent', 'schedule')->json('proposal.actions');

        $this->prayerOn();
        $with = $ask();
        $this->assertCount(3, $with);
        foreach ($with as $action) {
            $this->assertSame(self::DAY, CarbonImmutable::parse($action['starts_at'])->toDateString());
            $this->assertFalse($this->touchesAWindow($action), $action['title'].' '.$action['starts_at']);
        }

        $this->setPrefs(['prayer_enabled' => false]);
        $without = $ask();
        $this->setPrefs(['prayer_enabled' => true]);
        $this->assertTrue(collect($without)->contains(fn ($a) => $this->touchesAWindow($a)), 'without prayer times the first block starts at 09:00 across Dhuhr (precondition)');
    }

    public function test_iftar_and_prayer_windows_in_the_planning_config_follow_the_users_own_settings_only(): void
    {
        $other = User::factory()->create();
        UserSetting::create(['user_id' => $other->id, 'preferences' => ['timezone' => 'UTC']]);
        $this->prayerOn();
        $planning = app(PlanningService::class);

        $mine = $planning->config($this->user->fresh());
        $theirs = $planning->config($other);
        $this->assertNotEmpty($planning->protectedIntervals($mine, CarbonImmutable::parse(self::DAY.' 00:00'), CarbonImmutable::parse(self::DAY.' 23:59')));
        $this->assertSame([], $planning->protectedIntervals($theirs, CarbonImmutable::parse(self::DAY.' 00:00'), CarbonImmutable::parse(self::DAY.' 23:59')));
    }
}
