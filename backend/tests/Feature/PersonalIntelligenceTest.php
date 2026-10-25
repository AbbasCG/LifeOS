<?php

namespace Tests\Feature;

use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\ExternalEvent;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\IntelligenceService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PersonalIntelligenceTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Tuesday 23 March 2027, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2027-03-23 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        $this->actingAs($this->user);
    }

    private function at(string $local): CarbonImmutable
    {
        return CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
    }

    private function snapshot(): array
    {
        $service = app(IntelligenceService::class);
        $service->forget($this->user);

        return $service->snapshot($this->user->fresh());
    }

    public function test_priorities_are_scored_explained_and_isolated_per_user(): void
    {
        $overdue = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Overdue report', 'priority' => 'high', 'estimated_minutes' => 60, 'due_at' => $this->at('2027-03-22 17:00')]);
        $risky = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tender', 'priority' => 'medium', 'estimated_minutes' => 480, 'due_at' => $this->at('2027-03-23 16:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Someday', 'priority' => 'low', 'estimated_minutes' => 60, 'due_at' => null]);
        Task::factory()->create(['user_id' => User::factory()->create()->id, 'title' => 'Not mine', 'priority' => 'urgent', 'due_at' => $this->at('2027-03-23 10:00')]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'kind' => 'fixed', 'starts_at' => $this->at('2027-03-23 09:00'), 'ends_at' => $this->at('2027-03-23 15:00')]);

        $p = collect($this->snapshot()['priorities'])->keyBy('title');
        $this->assertArrayNotHasKey('Not mine', $p->all());
        $this->assertSame(['Overdue report', 'Tender', 'Someday'], $p->keys()->all());
        $this->assertContains('overdue', $p['Overdue report']['reasons']);
        $this->assertSame(['high', 'high'], [$p['Overdue report']['risk'], $p['Overdue report']['confidence']]);
        $this->assertContains('deadline_risk', $p['Tender']['reasons'], '8h of work does not fit before 16:00 around a 6h workshop');
        $this->assertSame(['high', 'medium', ['tasks', 'calendar']], [$p['Tender']['risk'], $p['Tender']['confidence'], $p['Tender']['sources']]);
        $this->assertSame('low', $p['Someday']['risk']);
        $this->assertTrue($p->every(fn ($row) => $row['score'] >= 0 && $row['score'] <= 100));

        $this->getJson('/api/intelligence/briefing')->assertOk()->assertJsonPath('priorities.0.id', $overdue->id)->assertJsonPath('deadlines.1.id', $risky->id)
            ->assertJsonMissing(['title' => 'Not mine']);
    }

    public function test_deadline_postponements_are_counted_only_when_moved_later(): void
    {
        $task = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tax return', 'due_at' => null]);
        $task->update(['due_at' => $this->at('2027-03-24 12:00')]);
        $this->assertSame(0, $task->fresh()->postponed_count, 'setting a first deadline is not a postponement');
        $task->update(['due_at' => $this->at('2027-03-24 12:30')]);
        $this->assertSame(0, $task->fresh()->postponed_count, 'a small adjustment is not a postponement');
        $task->update(['due_at' => $this->at('2027-03-26 12:00')]);
        $task->update(['due_at' => $this->at('2027-03-25 12:00')]);
        $task->update(['due_at' => $this->at('2027-03-30 12:00')]);
        $this->assertSame(2, $task->fresh()->postponed_count);
        $this->assertNotNull($task->fresh()->last_postponed_at);

        $this->assertSame([['Tax return', 2]], collect($this->snapshot()['postponed'])->map(fn ($p) => [$p['title'], $p['postponed_count']])->all());
        $this->assertContains('postponed', collect($this->snapshot()['priorities'])->firstWhere('title', 'Tax return')['reasons']);

        $recurring = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Weekly report', 'recurrence' => 'weekly', 'due_at' => $this->at('2027-03-23 12:00'), 'postponed_count' => 3]);
        $this->assertSame(0, $recurring->createNextOccurrence()->postponed_count, 'the next occurrence starts fresh');
    }

    public function test_focus_capacity_and_its_confidence_come_from_history(): void
    {
        $empty = $this->snapshot()['focus_capacity'];
        $this->assertSame(['low', 480, null], [$empty['confidence'], $empty['minutes'], $empty['typical_daily_minutes']], 'no history: the free time, with low confidence');

        for ($d = 1; $d <= 6; $d++) {
            foreach ([0, 1] as $n) {
                FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 3000, 'elapsed_seconds' => 3000,
                    'started_at' => $this->at('2027-03-23 09:00')->subDays($d)->addHours($n * 2), 'completed_at' => $this->at('2027-03-23 09:50')->subDays($d)->addHours($n * 2)]);
            }
        }
        $history = $this->snapshot()['focus_capacity'];
        $this->assertSame(['high', 100, 120], [$history['confidence'], $history['typical_daily_minutes'], $history['minutes']], '12 sessions over 6 days: typical 100 min/day, about 1.2× fits today');
        $this->assertSame(['sessions' => 12, 'days' => 6, 'window_days' => 14], $history['basis']);

        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->preferences(), ['daily_focus_limit' => 90])]);
        $this->assertSame(90, $this->snapshot()['focus_capacity']['minutes'], 'the user\'s own daily limit wins');
    }

    public function test_data_source_permissions_limit_what_the_engine_reads(): void
    {
        $google = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@gmail.com', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'calendar_id' => 'c', 'external_id' => 'g1', 'title' => 'Client call', 'starts_at' => $this->at('2027-03-23 10:00'), 'ends_at' => $this->at('2027-03-23 11:00')]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Write report', 'kind' => 'flexible', 'task_id' => Task::factory()->create(['user_id' => $this->user->id])->id, 'starts_at' => $this->at('2027-03-23 10:30'), 'ends_at' => $this->at('2027-03-23 11:30')]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Dentist', 'kind' => 'fixed', 'starts_at' => $this->at('2027-03-23 14:00'), 'ends_at' => $this->at('2027-03-23 15:00')]);
        Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Run a marathon', 'progress' => 5, 'target' => 100, 'created_at' => now()->subDays(60), 'due_at' => now()->addDays(5)]);
        $meetings = fn () => collect($this->getJson('/api/intelligence/briefing')->json('meetings'))->pluck('title')->all();

        $this->assertSame(['Client call', 'Dentist'], $meetings());
        $this->assertCount(1, $this->snapshot()['conflicts']);
        $this->assertNotEmpty($this->snapshot()['goals']);

        $this->putJson('/api/intelligence/settings', ['sources' => ['connected' => false, 'goals' => false]])->assertOk();
        $this->assertSame(['Dentist'], $meetings(), 'connected calendars are not read');
        $this->assertCount(0, $this->snapshot()['conflicts']);
        $this->assertCount(0, $this->snapshot()['goals']);
        $this->assertNotContains('connected', $this->snapshot()['sources']);

        $this->putJson('/api/intelligence/settings', ['sources' => ['calendar' => false]])->assertOk();
        $this->assertSame([], $meetings());
        $this->putJson('/api/intelligence/settings', ['features' => ['briefing' => false]])->assertOk();
        $this->getJson('/api/intelligence/briefing')->assertOk()->assertExactJson(['enabled' => false]);
    }

    public function test_briefing_uses_the_local_day_across_timezones(): void
    {
        // 23:30 in Auckland on Tuesday is still Tuesday morning in UTC.
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->preferences(), ['timezone' => 'Pacific/Auckland'])]);
        $this->travelTo(CarbonImmutable::parse('2027-03-23 23:30', 'Pacific/Auckland'));
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Due Auckland tomorrow', 'priority' => 'high', 'due_at' => CarbonImmutable::parse('2027-03-24 10:00', 'Pacific/Auckland')->utc()]);
        $b = $this->getJson('/api/intelligence/briefing')->assertOk();
        $this->assertSame(['2027-03-23', 'Pacific/Auckland'], [$b->json('date'), $b->json('timezone')]);
        $this->assertSame([], $b->json('focus.windows'), 'no working time is left in the local day');
        $this->assertSame('Due Auckland tomorrow', $b->json('deadlines.0.title'));
        $this->assertSame('2027-03-23', collect($b->json('overloaded'))->pluck('date')->first() ?? '2027-03-23');
    }
}
