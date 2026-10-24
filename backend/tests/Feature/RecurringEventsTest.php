<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\CalendarEventException;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RecurringEventsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-01-04 07:00:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5]]]);
        $this->actingAs($this->user);
    }

    /**
     * @param  array<string, mixed>  $rule
     * @return list<string>
     */
    private function starts(array $rule, string $start = '2027-01-04T09:00:00Z', string $tz = 'UTC', string $to = '2027-12-31T00:00:00Z'): array
    {
        $event = new CalendarEvent(['title' => 'X', 'starts_at' => $start, 'ends_at' => CarbonImmutable::parse($start)->addHour(), 'recurrence' => $rule, 'timezone' => $tz]);

        return collect(app(CalendarService::class)->occurrenceStarts($event, CarbonImmutable::parse($to)))->map(fn ($s) => $s->toIso8601String())->all();
    }

    public function test_daily_with_interval_and_count(): void
    {
        $this->assertSame(['2027-01-04T09:00:00+00:00', '2027-01-07T09:00:00+00:00', '2027-01-10T09:00:00+00:00'], $this->starts(['freq' => 'daily', 'interval' => 3, 'count' => 3]));
    }

    public function test_weekly_on_selected_weekdays_every_other_week_until_a_date(): void
    {
        // Monday 2027-01-04; Mon(1) + Thu(4) every 2 weeks until 2027-01-21.
        $this->assertSame(
            ['2027-01-04T09:00:00+00:00', '2027-01-07T09:00:00+00:00', '2027-01-18T09:00:00+00:00', '2027-01-21T09:00:00+00:00'],
            $this->starts(['freq' => 'weekly', 'interval' => 2, 'by_weekday' => [4, 1], 'until' => '2027-01-21'])
        );
    }

    public function test_weekly_skips_selected_days_before_the_first_occurrence(): void
    {
        $this->assertSame(['2027-01-06T09:00:00+00:00', '2027-01-11T09:00:00+00:00'], $this->starts(['freq' => 'weekly', 'by_weekday' => [1, 3], 'count' => 2], '2027-01-06T09:00:00Z'));
    }

    public function test_monthly_skips_months_without_the_day_and_yearly_skips_non_leap_years(): void
    {
        $this->assertSame(['2027-01-31T09:00:00+00:00', '2027-03-31T09:00:00+00:00', '2027-05-31T09:00:00+00:00'], $this->starts(['freq' => 'monthly', 'count' => 3], '2027-01-31T09:00:00Z'));
        $this->assertSame(['2028-02-29T09:00:00+00:00', '2032-02-29T09:00:00+00:00'], $this->starts(['freq' => 'yearly', 'count' => 2], '2028-02-29T09:00:00Z', 'UTC', '2040-01-01T00:00:00Z'));
    }

    public function test_wall_clock_time_is_kept_across_daylight_saving_changes(): void
    {
        // 09:00 Amsterdam is 08:00 UTC in winter and 07:00 UTC in summer (DST starts 2027-03-28).
        $starts = $this->starts(['freq' => 'weekly', 'count' => 2], '2027-03-22T08:00:00Z', 'Europe/Amsterdam');
        $this->assertSame(['2027-03-22T08:00:00+00:00', '2027-03-29T07:00:00+00:00'], $starts);
    }

    public function test_creating_a_series_stores_one_row_and_expands_in_the_calendar_window(): void
    {
        $this->postJson('/api/events', ['title' => 'Standup', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T09:15:00Z', 'recurrence' => ['freq' => 'weekly', 'by_weekday' => [1, 2, 3, 4, 5]]])
            ->assertCreated()->assertJsonPath('data.recurrence.freq', 'weekly')->assertJsonPath('data.timezone', 'UTC');
        $this->assertDatabaseCount('calendar_events', 1);

        $this->getJson('/api/calendar?from=2027-01-04T00:00:00Z&to=2027-01-18T00:00:00Z')->assertOk()
            ->assertJsonCount(10, 'data')
            ->assertJsonPath('data.0.recurring', true)
            ->assertJsonPath('data.0.occurrence_start', '2027-01-04T09:00:00+00:00');
        $this->getJson('/api/calendar?from=2030-03-04T00:00:00Z&to=2030-03-09T00:00:00Z')->assertJsonCount(5, 'data');
    }

    public function test_count_limited_series_record_their_last_date_for_indexing(): void
    {
        $id = $this->postJson('/api/events', ['title' => 'Course', 'starts_at' => '2027-01-04T18:00:00Z', 'ends_at' => '2027-01-04T19:00:00Z', 'recurrence' => ['freq' => 'weekly', 'count' => 4]])->json('data.id');

        $this->assertSame('2027-01-25', CalendarEvent::find($id)->recurrence_until->toDateString());
        $this->getJson('/api/calendar?from=2027-01-26T00:00:00Z&to=2027-03-01T00:00:00Z')->assertJsonCount(0, 'data');
    }

    public function test_editing_and_deleting_a_single_occurrence_creates_exceptions(): void
    {
        $id = $this->postJson('/api/events', ['title' => 'Gym', 'kind' => 'flexible', 'starts_at' => '2027-01-04T18:00:00Z', 'ends_at' => '2027-01-04T19:00:00Z', 'recurrence' => ['freq' => 'daily']])->json('data.id');

        $this->patchJson("/api/events/$id", ['scope' => 'occurrence', 'occurrence_start' => '2027-01-05T18:00:00Z', 'title' => 'Gym (legs)', 'starts_at' => '2027-01-05T19:00:00Z', 'ends_at' => '2027-01-05T20:30:00Z'])
            ->assertOk()->assertJsonPath('data.title', 'Gym (legs)')->assertJsonPath('data.is_exception', true);
        $this->deleteJson("/api/events/$id?scope=occurrence&occurrence_start=2027-01-06T18:00:00Z")->assertOk();
        $this->patchJson("/api/events/$id", ['scope' => 'occurrence', 'occurrence_start' => '2027-01-05T18:30:00Z', 'title' => 'Bad'])->assertUnprocessable()->assertJsonValidationErrors('occurrence_start');

        $occurrences = $this->getJson('/api/calendar?from=2027-01-04T00:00:00Z&to=2027-01-08T00:00:00Z')->json('data');
        $this->assertSame(['Gym', 'Gym (legs)', 'Gym'], array_column($occurrences, 'title'));
        $this->assertSame('2027-01-05T19:00:00+00:00', $occurrences[1]['starts_at']);
        $this->assertSame(2, CalendarEventException::count());
        $this->assertDatabaseCount('calendar_events', 1);
    }

    public function test_an_occurrence_moved_into_another_window_is_still_shown(): void
    {
        $id = $this->postJson('/api/events', ['title' => 'Review', 'kind' => 'flexible', 'starts_at' => '2027-01-04T10:00:00Z', 'ends_at' => '2027-01-04T11:00:00Z', 'recurrence' => ['freq' => 'weekly']])->json('data.id');
        $this->patchJson("/api/events/$id", ['scope' => 'occurrence', 'occurrence_start' => '2027-01-11T10:00:00Z', 'starts_at' => '2027-01-09T10:00:00Z', 'ends_at' => '2027-01-09T11:00:00Z'])->assertOk();

        $this->getJson('/api/calendar?from=2027-01-09T00:00:00Z&to=2027-01-10T00:00:00Z')->assertJsonCount(1, 'data')->assertJsonPath('data.0.occurrence_start', '2027-01-11T10:00:00+00:00');
        $this->getJson('/api/calendar?from=2027-01-11T00:00:00Z&to=2027-01-12T00:00:00Z')->assertJsonCount(0, 'data');
    }

    public function test_editing_the_series_moves_exceptions_with_it_and_deleting_removes_everything(): void
    {
        $id = $this->postJson('/api/events', ['title' => 'Class', 'kind' => 'flexible', 'starts_at' => '2027-01-04T10:00:00Z', 'ends_at' => '2027-01-04T11:00:00Z', 'recurrence' => ['freq' => 'daily', 'count' => 5]])->json('data.id');
        $this->deleteJson("/api/events/$id?scope=occurrence&occurrence_start=2027-01-05T10:00:00Z")->assertOk();

        $this->patchJson("/api/events/$id", ['starts_at' => '2027-01-04T12:00:00Z', 'ends_at' => '2027-01-04T13:00:00Z'])->assertOk();
        $this->assertSame('2027-01-05T12:00:00+00:00', CalendarEventException::first()->original_start->toIso8601String());
        $this->getJson('/api/calendar?from=2027-01-04T00:00:00Z&to=2027-01-10T00:00:00Z')->assertJsonCount(4, 'data');

        $this->patchJson("/api/events/$id", ['recurrence' => ['freq' => 'weekly', 'count' => 2]])->assertOk();
        $this->assertSame(0, CalendarEventException::count());

        $this->deleteJson("/api/events/$id")->assertOk();
        $this->assertDatabaseCount('calendar_events', 0);
    }

    public function test_conflicts_are_detected_for_occurrences_and_series(): void
    {
        $this->postJson('/api/events', ['title' => 'Standup', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T09:30:00Z', 'recurrence' => ['freq' => 'daily']])->assertCreated();

        $this->postJson('/api/events', ['title' => 'Dentist', 'starts_at' => '2027-01-07T09:15:00Z', 'ends_at' => '2027-01-07T10:00:00Z'])
            ->assertUnprocessable()->assertJsonFragment(['This time conflicts with “Standup” (2027-01-07T09:00:00+00:00 – 2027-01-07T09:30:00+00:00). Choose another time.']);
        $this->postJson('/api/events', ['title' => 'Dentist', 'starts_at' => '2027-01-07T09:30:00Z', 'ends_at' => '2027-01-07T10:00:00Z'])->assertCreated();

        $series = ['title' => 'Planning', 'starts_at' => '2027-01-04T09:20:00Z', 'ends_at' => '2027-01-04T09:40:00Z', 'recurrence' => ['freq' => 'weekly']];
        $this->postJson('/api/events', $series)->assertUnprocessable()->assertJsonValidationErrors('recurrence_conflicts');
        $this->postJson('/api/events', $series + ['ignore_conflicts' => true])->assertCreated();
    }

    public function test_fixed_occurrences_are_protected(): void
    {
        $id = $this->postJson('/api/events', ['title' => 'Lecture', 'kind' => 'fixed', 'starts_at' => '2027-01-04T13:00:00Z', 'ends_at' => '2027-01-04T14:00:00Z', 'recurrence' => ['freq' => 'weekly']])->json('data.id');
        $move = ['scope' => 'occurrence', 'occurrence_start' => '2027-01-11T13:00:00Z', 'starts_at' => '2027-01-11T15:00:00Z', 'ends_at' => '2027-01-11T16:00:00Z'];

        $this->patchJson("/api/events/$id", $move)->assertUnprocessable()->assertJsonValidationErrors('fixed');
        $this->patchJson("/api/events/$id", $move + ['confirm_fixed' => true])->assertOk();
    }

    public function test_validation_and_ownership(): void
    {
        $this->postJson('/api/events', ['title' => 'X', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T10:00:00Z', 'recurrence' => ['freq' => 'hourly']])->assertUnprocessable();
        $this->postJson('/api/events', ['title' => 'X', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T10:00:00Z', 'recurrence' => ['freq' => 'daily', 'count' => 3, 'until' => '2027-02-01']])->assertUnprocessable();
        $this->postJson('/api/events', ['title' => 'X', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T10:00:00Z', 'recurrence' => ['freq' => 'daily', 'until' => '2026-12-01']])->assertUnprocessable();
        $this->getJson('/api/calendar?from=2027-01-01T00:00:00Z&to=2027-06-01T00:00:00Z')->assertUnprocessable();

        $foreign = CalendarEvent::create(['user_id' => User::factory()->create()->id, 'title' => 'Private', 'starts_at' => '2027-01-04T15:00:00Z', 'ends_at' => '2027-01-04T16:00:00Z', 'recurrence' => ['freq' => 'daily'], 'timezone' => 'UTC']);
        $this->patchJson("/api/events/{$foreign->id}", ['title' => 'Mine'])->assertNotFound();
        $this->deleteJson("/api/events/{$foreign->id}?scope=occurrence&occurrence_start=2027-01-05T15:00:00Z")->assertNotFound();
        $this->assertStringNotContainsString('Private', $this->getJson('/api/calendar?from=2027-01-04T00:00:00Z&to=2027-01-06T00:00:00Z')->getContent());
    }

    public function test_recurring_commitments_block_planning_and_availability(): void
    {
        $this->postJson('/api/events', ['title' => 'Morning class', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T12:00:00Z', 'recurrence' => ['freq' => 'weekly', 'by_weekday' => [1, 2, 3, 4, 5]]])->assertCreated();
        Task::create(['user_id' => $this->user->id, 'title' => 'Essay', 'estimated_minutes' => 60]);

        $plan = $this->postJson('/api/plans', ['date' => '2027-01-05', 'days' => 1])->assertCreated()->json();
        $this->assertSame('2027-01-05T12:10:00+00:00', $plan['items'][0]['starts_at']);
        $this->assertSame(180, $plan['summary']['days'][0]['fixed_minutes']);
        $this->getJson('/api/availability?date=2027-01-06')->assertJsonPath('days.0.free_minutes', 300)->assertJsonPath('days.0.slots.0.starts_at', '2027-01-06T12:00:00+00:00');
        $this->getJson('/api/briefing')->assertJsonPath('agenda.0.title', 'Morning class')->assertJsonPath('agenda.0.recurring', true);
    }
}
