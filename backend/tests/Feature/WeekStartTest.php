<?php

namespace Tests\Feature;

use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\InboxNotification;
use App\Models\PlanTemplate;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Models\WeeklyReview;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/** The first day of the week is a per-user setting (0 = Sunday ... 6 = Saturday, default Monday). */
class WeekStartTest extends TestCase
{
    use RefreshDatabase;

    private const REVIEW_TITLE = 'Review your week and plan the next';

    private function user(?int $weekStart, string $tz = 'UTC', array $extra = []): User
    {
        config(['ai.provider' => 'disabled']);
        $user = User::factory()->create();
        $prefs = ['timezone' => $tz, 'language' => 'en'] + ($weekStart === null ? [] : ['week_start' => $weekStart]) + $extra;
        UserSetting::create(['user_id' => $user->id, 'preferences' => $prefs]);

        return $user;
    }

    /** @return array<string, array{0: int}> */
    public static function weekStarts(): array
    {
        return ['monday' => [1], 'sunday' => [0], 'saturday' => [6]];
    }

    // ---- validation and defaults ----

    public function test_settings_return_the_defaults_for_the_three_keys(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user)->getJson('/api/settings')->assertOk()
            ->assertJsonPath('week_start', 1)->assertJsonPath('calendar_system', 'gregorian')->assertJsonPath('hijri_offset', 0);

        // An account that saved settings before the keys existed still gets them back.
        $old = $this->user(null);
        $this->actingAs($old)->getJson('/api/settings')->assertOk()
            ->assertJsonPath('week_start', 1)->assertJsonPath('calendar_system', 'gregorian')->assertJsonPath('hijri_offset', 0);
        $this->assertArrayNotHasKey('week_start', $old->preferences());
        $this->assertSame(1, $old->weekStartDay());
    }

    public function test_week_start_and_the_display_preferences_are_stored_and_returned(): void
    {
        $user = $this->user(null);
        $this->actingAs($user)->putJson('/api/settings', ['week_start' => 6, 'calendar_system' => 'hijri', 'hijri_offset' => -2])->assertOk()
            ->assertJsonPath('week_start', 6)->assertJsonPath('calendar_system', 'hijri')->assertJsonPath('hijri_offset', -2);
        $this->actingAs($user)->getJson('/api/settings')->assertJsonPath('week_start', 6)->assertJsonPath('calendar_system', 'hijri')->assertJsonPath('hijri_offset', -2);
        $this->assertSame(6, $user->weekStartDay());
        $this->actingAs($user)->putJson('/api/settings', ['week_start' => 0, 'hijri_offset' => 2])->assertOk()->assertJsonPath('calendar_system', 'hijri');
        $this->assertSame(0, $user->weekStartDay());
    }

    #[DataProvider('invalidSettings')]
    public function test_invalid_values_are_refused(array $payload, string $field): void
    {
        $user = $this->user(1);
        $this->actingAs($user)->putJson('/api/settings', $payload)->assertStatus(422)->assertJsonValidationErrors($field);
        $this->assertSame(1, $user->weekStartDay());
    }

    /** @return array<string, array{0: array<string, mixed>, 1: string}> */
    public static function invalidSettings(): array
    {
        return [
            'week 7' => [['week_start' => 7], 'week_start'], 'week -1' => [['week_start' => -1], 'week_start'], 'week x' => [['week_start' => 'x'], 'week_start'],
            'week 1.5' => [['week_start' => 1.5], 'week_start'],
            'system' => [['calendar_system' => 'julian'], 'calendar_system'],
            'offset 3' => [['hijri_offset' => 3], 'hijri_offset'], 'offset -3' => [['hijri_offset' => -3], 'hijri_offset'], 'offset x' => [['hijri_offset' => 'x'], 'hijri_offset'],
        ];
    }

    // ---- the week boundary in each place ----

    /** @return array<string, array{0: int, 1: string, 2: string}> weekStart, today (UTC), expected first day of the coming week */
    public static function draftWeeks(): array
    {
        return [
            'monday on saturday' => [1, '2026-11-14 12:00', '2026-11-16'], 'sunday on saturday' => [0, '2026-11-14 12:00', '2026-11-15'], 'saturday on saturday' => [6, '2026-11-14 12:00', '2026-11-21'],
            'monday on sunday' => [1, '2026-11-15 12:00', '2026-11-16'], 'sunday on sunday' => [0, '2026-11-15 12:00', '2026-11-22'], 'saturday on sunday' => [6, '2026-11-15 12:00', '2026-11-21'],
            'monday on friday' => [1, '2026-11-13 12:00', '2026-11-16'], 'sunday on friday' => [0, '2026-11-13 12:00', '2026-11-15'], 'saturday on friday' => [6, '2026-11-13 12:00', '2026-11-14'],
        ];
    }

    #[DataProvider('draftWeeks')]
    public function test_the_weekly_draft_targets_the_coming_week_of_the_users_week(int $weekStart, string $now, string $expected): void
    {
        $this->travelTo(CarbonImmutable::parse($now, 'UTC'));
        $user = $this->user($weekStart);
        $this->actingAs($user)->getJson('/api/copilot/weekly-draft')->assertOk()->assertJsonPath('next_week', $expected);
    }

    public function test_the_default_user_keeps_the_monday_week_everywhere(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-11-15 12:00', 'UTC')); // a Sunday
        $user = $this->user(null);
        $this->actingAs($user)->getJson('/api/copilot/weekly-draft')->assertJsonPath('next_week', '2026-11-16');
        $this->actingAs($user)->getJson('/api/reviews/2026-11-15')->assertOk()->assertJsonPath('week_start', '2026-11-09')->assertJsonPath('week_end', '2026-11-15');
        $this->actingAs($user)->getJson('/api/plans/insights')->assertOk()->assertJsonPath('from', '2026-11-09');
    }

    public function test_the_week_follows_the_users_timezone_near_midnight(): void
    {
        // 11:30 UTC on Saturday the 14th is 00:30 on Sunday the 15th in Auckland (UTC+13), but still Saturday in UTC.
        $this->travelTo(CarbonImmutable::parse('2026-11-14 11:30', 'UTC'));
        $auckland = $this->user(0, 'Pacific/Auckland');
        $this->actingAs($auckland)->getJson('/api/copilot/weekly-draft')->assertJsonPath('next_week', '2026-11-22');
        $this->actingAs($auckland)->getJson('/api/plans/insights')->assertJsonPath('from', '2026-11-15');
        $utc = $this->user(0);
        $this->actingAs($utc)->getJson('/api/copilot/weekly-draft')->assertJsonPath('next_week', '2026-11-15');

        // 07:30 UTC on Sunday the 15th is 23:30 on Saturday the 14th in Los Angeles (UTC-8).
        $this->travelTo(CarbonImmutable::parse('2026-11-15 07:30', 'UTC'));
        $la = $this->user(0, 'America/Los_Angeles');
        $this->actingAs($la)->getJson('/api/copilot/weekly-draft')->assertJsonPath('next_week', '2026-11-15');
        $this->actingAs($la)->getJson('/api/plans/insights')->assertJsonPath('from', '2026-11-08');
        $this->actingAs($la)->getJson('/api/reviews/2026-11-14')->assertJsonPath('week_start', '2026-11-08');
    }

    #[DataProvider('weekStarts')]
    public function test_the_weekly_review_starts_on_the_users_first_day(int $weekStart): void
    {
        $user = $this->user($weekStart);
        // Every day from Friday 13 to Sunday 15 November 2026 lands in the week that starts on the most recent first day.
        $expected = ['2026-11-13' => [1 => '2026-11-09', 0 => '2026-11-08', 6 => '2026-11-07'], '2026-11-14' => [1 => '2026-11-09', 0 => '2026-11-08', 6 => '2026-11-14'],
            '2026-11-15' => [1 => '2026-11-09', 0 => '2026-11-15', 6 => '2026-11-14']];
        foreach ($expected as $day => $starts) {
            $this->actingAs($user)->getJson("/api/reviews/{$day}")->assertOk()
                ->assertJsonPath('week_start', $starts[$weekStart])
                ->assertJsonPath('week_end', CarbonImmutable::parse($starts[$weekStart])->addDays(6)->toDateString());
        }
    }

    public function test_analytics_week_to_date_counts_from_the_users_first_day(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-11-14 12:00', 'UTC')); // Saturday
        $done = fn (User $u, string $at) => Task::factory()->create(['user_id' => $u->id, 'status' => 'completed', 'completed_at' => CarbonImmutable::parse($at, 'UTC')]);
        $users = [1 => $this->user(1), 0 => $this->user(0), 6 => $this->user(6)];
        foreach ($users as $u) {
            $done($u, '2026-11-14 09:00'); // Saturday
            $done($u, '2026-11-13 10:00'); // Friday
            $done($u, '2026-11-08 10:00'); // the Sunday before
        }
        // Monday week: Sat + Fri; Sunday week: Sat + Fri + that Sunday; Saturday week: only today's Saturday.
        foreach ([1 => ['2026-11-09', 2], 0 => ['2026-11-08', 3], 6 => ['2026-11-14', 1]] as $weekStart => [$from, $count]) {
            $this->actingAs($users[$weekStart])->getJson('/api/analytics?days=14')->assertOk()
                ->assertJsonPath('periods.week.from', $from)->assertJsonPath('periods.week.current.completed', $count);
        }
    }

    public function test_the_weekly_habit_streak_bucket_follows_the_week_start(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-11-15 12:00', 'UTC')); // Sunday
        $streaks = [];
        foreach ([1, 0, 6] as $weekStart) {
            $user = $this->user($weekStart);
            $habit = Habit::factory()->weekly()->create(['user_id' => $user->id]);
            foreach (['2026-11-14', '2026-11-15'] as $date) { // Saturday and Sunday
                HabitEntry::create(['habit_id' => $habit->id, 'date' => $date]);
            }
            $streaks[$weekStart] = $this->actingAs($user)->getJson('/api/habits')->assertOk()->json('data.0.current_streak');
        }
        // Monday week: Sat and Sun are one week. Sunday week: Sat closes the previous week and Sun opens a new one. Saturday week: one week.
        $this->assertSame([1 => 1, 0 => 2, 6 => 1], $streaks);
    }

    #[DataProvider('weekStarts')]
    public function test_the_weekly_habit_reminder_stops_at_the_users_week_boundary(int $weekStart): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-11-15 12:00', 'UTC')); // Sunday
        $user = $this->user($weekStart);
        $habit = Habit::factory()->weekly()->create(['user_id' => $user->id, 'remind_time' => '08:00']);
        HabitEntry::create(['habit_id' => $habit->id, 'date' => '2026-11-14']); // logged on Saturday

        $this->artisan('lifeos:reminders')->assertSuccessful();
        // Done this week when Saturday is in the same week as Sunday (Monday and Saturday weeks); a new week has begun on Sunday for a Sunday week.
        $this->assertSame($weekStart === 0 ? 1 : 0, InboxNotification::where('user_id', $user->id)->where('title', 'Habit: '.$habit->title)->count());
    }

    /** @return array<string, array{0: int, 1: string, 2: bool}> weekStart, now (UTC), whether the review reminder is sent */
    public static function reviewDays(): array
    {
        return [
            'monday: sunday evening' => [1, '2026-11-15 18:00', true], 'monday: saturday evening' => [1, '2026-11-14 18:00', false], 'monday: friday evening' => [1, '2026-11-13 18:00', false],
            'sunday: saturday evening' => [0, '2026-11-14 18:00', true], 'sunday: sunday evening' => [0, '2026-11-15 18:00', false], 'sunday: friday evening' => [0, '2026-11-13 18:00', false],
            'saturday: friday evening' => [6, '2026-11-13 18:00', true], 'saturday: saturday evening' => [6, '2026-11-14 18:00', false], 'saturday: sunday evening' => [6, '2026-11-15 18:00', false],
            'sunday: saturday before 17:00' => [0, '2026-11-14 16:00', false],
        ];
    }

    #[DataProvider('reviewDays')]
    public function test_the_review_reminder_is_sent_the_day_before_the_week_starts(int $weekStart, string $now, bool $sent): void
    {
        $this->travelTo(CarbonImmutable::parse($now, 'UTC'));
        $user = $this->user($weekStart, 'UTC', ['work_days' => [1]]);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame($sent ? 1 : 0, InboxNotification::where('user_id', $user->id)->where('title', self::REVIEW_TITLE)->count());
    }

    public function test_the_review_reminder_uses_the_users_local_day(): void
    {
        // 06:00 UTC on Saturday is 17:00 on Saturday in Sydney (UTC+11), so a Sunday-week user there is reminded; the UTC user is not yet (06:00).
        $this->travelTo(CarbonImmutable::parse('2026-11-14 06:00', 'UTC'));
        $sydney = $this->user(0, 'Australia/Sydney', ['work_days' => [1]]);
        $utc = $this->user(0, 'UTC', ['work_days' => [1]]);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame(1, InboxNotification::where('user_id', $sydney->id)->where('title', self::REVIEW_TITLE)->count());
        $this->assertSame(0, InboxNotification::where('user_id', $utc->id)->where('title', self::REVIEW_TITLE)->count());
    }

    #[DataProvider('templateWeeks')]
    public function test_a_template_week_keeps_its_weekdays_and_starts_on_the_users_first_day(int $weekStart, string $monday, string $sunday, string $range): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-11-14 12:00', 'UTC')); // Saturday; "next week" is the coming week of the user's calendar
        $user = $this->user($weekStart);
        PlanTemplate::create(['user_id' => $user->id, 'name' => 'Deep week', 'blocks' => [
            ['weekday' => 1, 'start' => '09:00', 'minutes' => 60, 'title' => 'Monday block', 'task_id' => null],
            ['weekday' => 7, 'start' => '10:00', 'minutes' => 60, 'title' => 'Sunday block', 'task_id' => null],
        ]]);
        $r = $this->actingAs($user)->postJson('/api/copilot/messages', ['message' => 'Plan next week from my template Deep week', 'language' => 'en'])->assertOk()
            ->assertJsonPath('message.intent', 'use_template');
        $starts = collect($r->json('message.proposal.actions'))->map(fn ($a) => CarbonImmutable::parse($a['starts_at'])->utc()->format('Y-m-d H:i'))->sort()->values()->all();
        $expected = [$monday.' 09:00', $sunday.' 10:00'];
        sort($expected);
        $this->assertSame($expected, $starts);
        $this->assertStringContainsString($range, $r->json('message.plan.explanation.0'));
    }

    /** @return array<string, array{0: int, 1: string, 2: string, 3: string}> */
    public static function templateWeeks(): array
    {
        return [
            'monday week' => [1, '2026-11-16', '2026-11-22', '16 Nov'],
            'sunday week' => [0, '2026-11-16', '2026-11-15', '15 Nov'],
            'saturday week' => [6, '2026-11-23', '2026-11-22', '21 Nov'],
        ];
    }

    // ---- reviews across a change of week start ----

    public function test_changing_the_week_start_keeps_old_reviews_and_never_duplicates_the_current_week(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-11-14 12:00', 'UTC')); // Saturday
        $user = $this->user(1);
        $this->actingAs($user)->putJson('/api/reviews/2026-11-14', ['reflection' => ['wins' => 'Monday week']])->assertOk()->assertJsonPath('week_start', '2026-11-09');
        $this->assertSame(['2026-11-09'], WeeklyReview::where('user_id', $user->id)->pluck('week_start')->map(fn ($d) => substr((string) $d, 0, 10))->all());

        $this->actingAs($user)->putJson('/api/settings', ['week_start' => 0])->assertOk();

        // The current week now resolves to the new boundary: a fresh review, the old one is untouched.
        $this->actingAs($user)->getJson('/api/reviews/2026-11-14')->assertOk()->assertJsonPath('week_start', '2026-11-08')->assertJsonPath('review.status', 'new')->assertJsonPath('review.reflection.wins', '');
        $this->assertSame(1, WeeklyReview::where('user_id', $user->id)->count());

        foreach (['first', 'second'] as $attempt) { // saving twice updates the same row
            $this->actingAs($user)->putJson('/api/reviews/2026-11-14', ['reflection' => ['wins' => "Sunday week {$attempt}"]])->assertOk()->assertJsonPath('week_start', '2026-11-08');
        }
        $stored = WeeklyReview::where('user_id', $user->id)->orderBy('week_start')->get();
        $this->assertSame(['2026-11-08', '2026-11-09'], $stored->map(fn ($r) => substr((string) $r->week_start, 0, 10))->all());
        $this->assertSame('Monday week', $stored->last()->reflection['wins']);
        $this->assertSame('Sunday week second', $stored->first()->reflection['wins']);

        $this->actingAs($user)->postJson('/api/reviews/2026-11-14/complete', [])->assertOk();
        $this->assertSame(2, WeeklyReview::where('user_id', $user->id)->count());
    }
}
