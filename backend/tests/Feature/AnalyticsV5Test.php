<?php

namespace Tests\Feature;

use App\Models\Category;
use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AnalyticsV5Test extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Wednesday 10 March 2027, 12:00 UTC.
        $this->travelTo(CarbonImmutable::parse('2027-03-10 12:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC']]);
    }

    private function focus(string $at, int $minutes, array $extra = []): FocusSession
    {
        return FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => $minutes * 60, 'elapsed_seconds' => $minutes * 60, 'completed_at' => CarbonImmutable::parse($at, 'UTC')] + $extra);
    }

    private function done(string $at, array $extra = []): Task
    {
        return Task::factory()->create(['user_id' => $this->user->id, 'status' => 'completed', 'completed_at' => CarbonImmutable::parse($at, 'UTC'), 'due_at' => null] + $extra);
    }

    public function test_custom_range_and_project_filter_only_count_matching_work(): void
    {
        $site = Project::factory()->create(['user_id' => $this->user->id, 'title' => 'Site']);
        $siteTask = $this->done('2027-03-02 10:00', ['project_id' => $site->id]);
        $this->done('2027-03-03 10:00');
        $this->done('2027-02-20 10:00', ['project_id' => $site->id]);
        $this->focus('2027-03-02 11:00', 50, ['task_id' => $siteTask->id]);
        $this->focus('2027-03-03 11:00', 25, ['project_id' => $site->id]);
        $this->focus('2027-03-04 11:00', 90);

        $all = $this->actingAs($this->user)->getJson('/api/analytics?from=2027-03-01&to=2027-03-07')->assertOk()
            ->assertJsonPath('range.days', 7)->assertJsonPath('range.custom', true)
            ->assertJsonPath('range.previous_from', '2027-02-22')->assertJsonPath('range.previous_to', '2027-02-28')
            ->assertJsonPath('totals.completed', 2)->assertJsonPath('totals.focus_minutes', 165);
        $this->assertCount(7, $all->json('series'));

        $this->actingAs($this->user)->getJson("/api/analytics?from=2027-03-01&to=2027-03-07&project_id={$site->id}")->assertOk()
            ->assertJsonPath('project.title', 'Site')
            ->assertJsonPath('totals.completed', 1)->assertJsonPath('totals.focus_minutes', 75)
            ->assertJsonPath('goals', []);

        $foreign = Project::factory()->create();
        $this->actingAs($this->user)->getJson("/api/analytics?project_id={$foreign->id}")->assertUnprocessable();
        $this->actingAs($this->user)->getJson('/api/analytics?from=2027-03-01&to=2027-03-20')->assertUnprocessable();
        $this->actingAs($this->user)->getJson('/api/analytics?from=2025-01-01&to=2027-03-01')->assertUnprocessable();
        $this->actingAs($this->user)->getJson('/api/analytics?from=2027-03-05')->assertUnprocessable();
    }

    public function test_energy_comparison_needs_enough_days_in_each_group(): void
    {
        foreach (['2027-03-01', '2027-03-02', '2027-03-03'] as $day) {
            DailyCheckin::create(['user_id' => $this->user->id, 'date' => $day, 'energy' => 5]);
            $this->focus("{$day} 10:00", 120);
        }
        foreach (['2027-03-04', '2027-03-05'] as $day) {
            DailyCheckin::create(['user_id' => $this->user->id, 'date' => $day, 'energy' => 1]);
            $this->focus("{$day} 10:00", 30);
        }

        $thin = $this->actingAs($this->user)->getJson('/api/analytics?days=14')->assertOk()->assertJsonPath('energy.reliable', false);
        $this->assertSame(['level' => 'high', 'days' => 3, 'avg_focus_minutes' => 120, 'avg_completed' => 0, 'reliable' => true], $thin->json('energy.groups.2'));
        $this->assertFalse(collect($thin->json('insights'))->contains(fn ($i) => str_contains($i['en'], 'high-energy days')));

        DailyCheckin::create(['user_id' => $this->user->id, 'date' => '2027-03-06', 'energy' => 2]);
        $this->focus('2027-03-06 10:00', 30);
        $enough = $this->actingAs($this->user)->getJson('/api/analytics?days=14')->assertOk()->assertJsonPath('energy.reliable', true)->assertJsonPath('energy.checked_in_days', 6);
        $insight = collect($enough->json('insights'))->first(fn ($i) => str_contains($i['en'], 'high-energy days'));
        $this->assertSame('On high-energy days (3 days) you average 120 focus minutes, versus 30 on lower-energy days (3 days). Put demanding work on those days.', $insight['en']);

        UserSetting::where('user_id', $this->user->id)->update(['preferences' => ['timezone' => 'UTC', 'checkins_enabled' => false]]);
        $this->actingAs($this->user)->getJson('/api/analytics?days=14')->assertOk()->assertJsonPath('energy.enabled', false)->assertJsonPath('energy.groups', []);
    }

    public function test_consistency_workload_goals_and_calendar_periods(): void
    {
        $study = Category::factory()->create(['user_id' => $this->user->id, 'area' => 'study']);
        $exam = $this->done('2027-03-08 15:00', ['category_id' => $study->id]);
        foreach (['2027-03-06', '2027-03-07', '2027-03-08', '2027-03-09', '2027-03-10'] as $day) {
            $this->focus("{$day} 09:00", 40);
        }
        $this->focus('2027-03-08 16:00', 60, ['task_id' => $exam->id]);
        // Last week up to the same moment (Monday 1 – Wednesday 3 March 12:00): one task and 60 minutes.
        $this->done('2027-03-02 10:00');
        $this->focus('2027-03-03 11:00', 60);
        Task::factory()->create(['user_id' => $this->user->id, 'status' => 'todo', 'estimated_minutes' => 90, 'actual_minutes' => 30, 'due_at' => CarbonImmutable::parse('2027-03-12 17:00', 'UTC')]);
        Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'progress' => 40]);

        $response = $this->actingAs($this->user)->getJson('/api/analytics?days=14')->assertOk()
            ->assertJsonPath('consistency.focus_days', 6)
            ->assertJsonPath('consistency.longest_streak', 5)
            ->assertJsonPath('consistency.current_streak', 5)
            ->assertJsonPath('workload.due_next_7_days.remaining_minutes', 60)
            ->assertJsonPath('goals.0.title', 'Thesis');
        $areas = collect($response->json('workload.by_area'))->keyBy('area');
        $this->assertSame(['completed' => 1, 'focus_minutes' => 60], ['completed' => $areas['study']['completed'], 'focus_minutes' => $areas['study']['focus_minutes']]);
        $this->assertSame(260, $areas['work']['focus_minutes']);
        $this->assertSame(1, $response->json('workload.completed_by_weekday.1.completed'));

        $week = $response->json('periods.week');
        $this->assertSame('2027-03-08', $week['from']);
        $this->assertSame(['completed' => 1, 'focus_minutes' => 60], $week['previous']);
        $this->assertSame(['completed' => 1, 'focus_minutes' => 180], $week['current']);
        // Both baselines are too small for a percentage.
        $this->assertSame(['completed' => null, 'focus_minutes' => null], $week['change']);
        $this->assertSame(['completed' => true, 'focus_minutes' => true], $week['small_base']);
        $this->assertSame('2027-03-01', $response->json('periods.month.from'));
        $this->assertTrue($response->json('comparison.completed.small_base'));
    }
}
