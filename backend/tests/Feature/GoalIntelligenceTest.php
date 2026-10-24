<?php

namespace Tests\Feature;

use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use App\Services\BriefingService;
use App\Services\GoalIntelligence;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class GoalIntelligenceTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-10 12:00', 'UTC'));
        $this->user = User::factory()->create();
    }

    private function goal(array $attrs): Goal
    {
        return Goal::create($attrs + ['user_id' => $this->user->id, 'title' => 'Goal', 'target' => 100]);
    }

    public function test_goal_status_reflects_pace_activity_and_deadline(): void
    {
        $behind = $this->goal(['title' => 'Behind', 'progress' => 20, 'created_at' => now()->subDays(80), 'due_at' => now()->addDays(20)]);
        $onTrack = $this->goal(['title' => 'On track', 'progress' => 60, 'created_at' => now()->subDays(50), 'due_at' => now()->addDays(50)]);
        $overdue = $this->goal(['title' => 'Late', 'progress' => 40, 'created_at' => now()->subDays(50), 'due_at' => now()->subDays(2)]);
        $done = $this->goal(['title' => 'Done', 'progress' => 100, 'created_at' => now()->subDays(50)]);
        $noDate = $this->goal(['title' => 'Someday', 'progress' => 10]);
        Task::create(['user_id' => $this->user->id, 'goal_id' => $onTrack->id, 'title' => 'Recent win', 'status' => 'completed', 'completed_at' => now()->subDays(3)]);
        Task::create(['user_id' => $this->user->id, 'goal_id' => $behind->id, 'title' => 'Next step', 'priority' => 'high']);

        $goals = app(GoalIntelligence::class)->goals($this->user)->keyBy('title');

        $this->assertSame('at_risk', $goals['Behind']['status']);
        $this->assertSame(80, $goals['Behind']['expected_percent']);
        $this->assertSame('Next step', $goals['Behind']['next_actions'][0]['title']);
        $this->assertSame('schedule', $goals['Behind']['recommendations'][0]['type']);
        $this->assertSame('on_track', $goals['On track']['status']);
        $this->assertSame(1, $goals['On track']['trend']['recent']);
        $this->assertSame('overdue', $goals['Late']['status']);
        $this->assertSame('completed', $goals['Done']['status']);
        $this->assertSame('no_deadline', $goals['Someday']['status']);
        $this->assertSame('add_task', $goals['Someday']['recommendations'][0]['type']);
        $this->assertEquals([$behind->id => 25, $overdue->id => 30], app(GoalIntelligence::class)->pressure($this->user));
    }

    public function test_milestones_become_task_suggestions_and_are_validated(): void
    {
        $id = $this->actingAs($this->user)->postJson('/api/goals', ['title' => 'Learn Spanish', 'target' => 100, 'milestones' => [['title' => 'Finish A1 course', 'completed' => true], ['title' => 'Book a tutor', 'completed' => false], ['title' => 'Read a short novel', 'completed' => false]]])->assertCreated()->json('data.id') ?? Goal::first()->id;
        Task::create(['user_id' => $this->user->id, 'goal_id' => $id, 'title' => 'Book a tutor']);
        $this->postJson('/api/goals', ['title' => 'Bad', 'milestones' => [['completed' => true]]])->assertUnprocessable();

        $goal = $this->getJson('/api/insights/progress')->assertOk()->json('goals.0');
        $this->assertSame(['done' => 1, 'total' => 3, 'next' => 'Book a tutor'], $goal['milestones']);
        $this->assertSame(['Read a short novel'], array_column($goal['suggested_tasks'], 'title'), 'existing tasks are not suggested again');
    }

    public function test_goal_pressure_lifts_tasks_that_serve_at_risk_goals(): void
    {
        $risky = $this->goal(['progress' => 10, 'created_at' => now()->subDays(90), 'due_at' => now()->addDays(10)]);
        $plain = Task::create(['user_id' => $this->user->id, 'title' => 'Unrelated', 'priority' => 'high']);
        $serving = Task::create(['user_id' => $this->user->id, 'title' => 'Serves goal', 'priority' => 'medium', 'goal_id' => $risky->id]);

        $ranked = BriefingService::rank(collect([$plain, $serving]), CarbonImmutable::now(), app(GoalIntelligence::class)->pressure($this->user));
        $this->assertSame('Serves goal', $ranked[0]['task']->title);
        $this->assertContains('goal', $ranked[0]['reasons']);
        $this->actingAs($this->user)->getJson('/api/briefing')->assertOk()->assertJsonPath('focus.0.title', 'Serves goal');
    }

    public function test_project_health_and_habit_consistency(): void
    {
        $stalled = Project::create(['user_id' => $this->user->id, 'title' => 'Stalled', 'status' => 'active', 'due_at' => now()->addDays(7), 'milestones' => [['title' => 'A', 'completed' => false], ['title' => 'B', 'completed' => false]]]);
        Task::create(['user_id' => $this->user->id, 'project_id' => $stalled->id, 'title' => 'Late', 'due_at' => now()->subDays(3)]);
        $healthy = Project::create(['user_id' => $this->user->id, 'title' => 'Healthy', 'status' => 'active']);
        Task::create(['user_id' => $this->user->id, 'project_id' => $healthy->id, 'title' => 'Done', 'status' => 'completed', 'completed_at' => now()->subDay()]);
        Task::create(['user_id' => $this->user->id, 'project_id' => $healthy->id, 'title' => 'Next']);
        $habit = Habit::create(['user_id' => $this->user->id, 'title' => 'Read', 'recurrence' => 'daily']);
        foreach (range(1, 20) as $d) {
            HabitEntry::create(['habit_id' => $habit->id, 'date' => now()->subDays($d)->toDateString()]);
        }

        $data = $this->actingAs($this->user)->getJson('/api/insights/progress')->assertOk();
        $projects = collect($data->json('projects'))->keyBy('title');
        $this->assertSame('at_risk', $projects['Stalled']['health']);
        $this->assertSame('healthy', $projects['Healthy']['health']);
        $habitData = $data->json('habits.0');
        $this->assertSame(20, $habitData['current_streak']);
        $this->assertTrue($habitData['at_risk']);
        $this->assertSame(67, $habitData['consistency']);
        $this->assertSame('up', $habitData['trend']);

        $this->actingAs(User::factory()->create())->getJson('/api/insights/progress')->assertJsonCount(0, 'goals')->assertJsonCount(0, 'projects');
    }
}
