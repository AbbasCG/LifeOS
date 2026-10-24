<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\Goal;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class CopilotTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Saturday 24 Oct 2026, 10:00 Amsterdam time.
        $this->travelTo(CarbonImmutable::parse('2026-10-24 10:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'break_minutes' => 10, 'work_days' => [1, 2, 3, 4, 5]]]);
    }

    private function ask(string $message, string $language = 'en'): TestResponse
    {
        return $this->actingAs($this->user)->postJson('/api/assistant', ['message' => $message, 'language' => $language]);
    }

    private function at(string $local): CarbonImmutable
    {
        return CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
    }

    public function test_queries_filter_by_project_priority_and_deadline_in_both_languages(): void
    {
        $website = Project::factory()->create(['user_id' => $this->user->id, 'title' => 'Website']);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Fix hero', 'project_id' => $website->id, 'priority' => 'urgent', 'due_at' => $this->at('2026-10-27 12:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Write copy', 'project_id' => $website->id, 'priority' => 'high', 'due_at' => $this->at('2026-10-28 12:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tidy CSS', 'project_id' => $website->id, 'priority' => 'low', 'due_at' => $this->at('2026-10-27 12:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Launch later', 'project_id' => $website->id, 'priority' => 'high', 'due_at' => $this->at('2026-11-20 12:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Other project task', 'priority' => 'high', 'due_at' => $this->at('2026-10-27 12:00')]);
        $stranger = Project::factory()->create(['title' => 'Website']);
        Task::factory()->create(['user_id' => $stranger->user_id, 'title' => 'Secret', 'project_id' => $stranger->id, 'priority' => 'urgent', 'due_at' => $this->at('2026-10-27 12:00')]);

        $response = $this->ask('Show high priority tasks for project Website due this week')->assertOk()->assertJsonPath('intent', 'query');
        $this->assertSame(['Fix hero', 'Write copy'], collect($response->json('tasks'))->pluck('title')->all());
        $this->assertStringContainsString('in project “Website”', $response->json('message'));
        $this->assertStringNotContainsString('Secret', $response->json('message'));

        $arabic = $this->ask('اعرض مهام مشروع Website', 'ar')->assertOk()->assertJsonPath('intent', 'query');
        $this->assertCount(4, $arabic->json('tasks'));
        $this->assertStringContainsString('في مشروع «Website»', $arabic->json('message'));

        Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Ship v2', 'progress' => 5, 'created_at' => now()->subDays(60), 'due_at' => now()->addDays(5)]);
        $goals = $this->ask('Which goals are at risk?')->assertOk()->assertJsonPath('intent', 'query');
        $this->assertSame('Ship v2', $goals->json('items.0.title'));
        $this->assertSame('/goals', $goals->json('items.0.link'));
    }

    public function test_explains_why_a_task_ranks_where_it_does(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tax filing', 'priority' => 'urgent', 'due_at' => $this->at('2026-10-23 17:00')]);
        $report = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Quarterly report', 'priority' => 'medium', 'estimated_minutes' => 90, 'due_at' => $this->at('2026-10-30 17:00')]);

        $response = $this->ask('Why is Quarterly report not first?')->assertOk()->assertJsonPath('intent', 'explain')->assertJsonPath('tasks.0.id', $report->id);
        $this->assertStringContainsString('ranks #2 of 2', $response->json('message'));
        $this->assertStringContainsString('Ahead of it', $response->json('message'));
        $this->assertStringContainsString('Tax filing', $response->json('message'));

        $this->ask('لماذا هذه المهمة أولاً؟', 'ar')->assertOk()->assertJsonPath('intent', 'explain')->assertJsonPath('tasks.0.title', 'Tax filing');
        $this->assertSame(0, AssistantProposal::count());
    }

    public function test_detects_overlaps_overloaded_days_and_deadlines_that_do_not_fit(): void
    {
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Client call', 'starts_at' => $this->at('2026-10-26 10:00'), 'ends_at' => $this->at('2026-10-26 11:00'), 'kind' => 'fixed']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Team sync', 'starts_at' => $this->at('2026-10-26 10:30'), 'ends_at' => $this->at('2026-10-26 11:30'), 'kind' => 'fixed']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'starts_at' => $this->at('2026-10-27 09:00'), 'ends_at' => $this->at('2026-10-27 16:30'), 'kind' => 'fixed']);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Huge migration', 'estimated_minutes' => 480, 'due_at' => $this->at('2026-10-26 12:00')]);

        $response = $this->ask('Do I have any conflicts this week?')->assertOk()->assertJsonPath('intent', 'conflicts');
        $types = collect($response->json('items'))->pluck('type');
        $this->assertTrue($types->contains('overlap'));
        $this->assertTrue($types->contains('overload'));
        $this->assertTrue($types->contains('deadline'));
        $this->assertSame('Client call ↔ Team sync', $response->json('items.0.title'));
        $this->assertSame(0, AssistantProposal::count());

        $this->ask('هل لدي تعارضات؟', 'ar')->assertOk()->assertJsonPath('intent', 'conflicts');
    }

    public function test_goal_plan_turns_milestones_into_tasks_only_after_approval(): void
    {
        $goal = Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Learn Spanish', 'progress' => 10, 'created_at' => now()->subDays(60), 'due_at' => now()->addDays(30), 'milestones' => [['title' => 'Finish A1 course', 'completed' => true], ['title' => 'Hold a 10-minute conversation', 'completed' => false], ['title' => 'Read a short story', 'completed' => false]]]);

        $proposal = $this->ask('Make a plan for my goal Learn Spanish')->assertOk()
            ->assertJsonPath('intent', 'goal_plan')
            ->assertJsonPath('proposal.kind', 'goal_plan')
            ->assertJsonCount(2, 'proposal.actions')
            ->json('proposal');
        $this->assertSame(0, Task::count());
        $this->assertSame(['create_task', 'create_task'], array_column($proposal['actions'], 'type'));
        $this->assertSame('high', $proposal['actions'][0]['priority']);
        $this->assertLessThanOrEqual($goal->due_at->getTimestamp(), CarbonImmutable::parse($proposal['actions'][1]['due_at'])->getTimestamp());

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertOk()->assertJsonPath('status', 'applied');
        $task = Task::sole();
        $this->assertSame(['Hold a 10-minute conversation', $goal->id, 'high', 'todo'], [$task->title, $task->goal_id, $task->priority, $task->status]);
        $this->assertTrue(AuditLog::where('user_id', $this->user->id)->where('action', 'ai_action_executed')->exists());

        // The created step is not proposed again, and a tampered goal id from another user is refused.
        $next = $this->ask('Plan steps for goal Learn Spanish')->assertJsonCount(1, 'proposal.actions')->json('proposal');
        $foreign = Goal::factory()->create();
        $stored = AssistantProposal::find($next['id']);
        $stored->update(['actions' => [array_merge($stored->actions[0], ['goal_id' => $foreign->id])]]);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$next['id']}/apply", ['action_ids' => ['a1']])->assertUnprocessable();
        $this->assertSame(1, Task::count());
    }

    public function test_triage_reschedules_overdue_tasks_and_rechecks_before_applying(): void
    {
        $tax = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tax filing', 'priority' => 'urgent', 'estimated_minutes' => 120, 'due_at' => $this->at('2026-10-21 17:00')]);
        $mail = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Answer mail', 'priority' => 'low', 'estimated_minutes' => 30, 'due_at' => $this->at('2026-10-22 17:00')]);
        Task::factory()->create(['title' => 'Not mine', 'due_at' => $this->at('2026-10-20 17:00')]);

        $proposal = $this->ask('Reschedule my overdue tasks')->assertOk()->assertJsonPath('intent', 'triage')->assertJsonPath('proposal.kind', 'triage')->assertJsonCount(2, 'proposal.actions')->json('proposal');
        $this->assertSame($tax->id, $proposal['actions'][0]['task_id']);
        // Saturday: the first work day with free time is Monday, end of working hours.
        $this->assertSame('2026-10-26 17:00', CarbonImmutable::parse($proposal['actions'][0]['due_at'])->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));
        $this->assertTrue($tax->fresh()->due_at->equalTo($this->at('2026-10-21 17:00')));

        $mail->update(['due_at' => $this->at('2026-10-29 17:00')]);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1', 'a2']])->assertUnprocessable();
        $this->assertTrue($tax->fresh()->due_at->equalTo($this->at('2026-10-21 17:00')), 'Nothing changes when one action is stale');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertTrue($tax->fresh()->due_at->equalTo($this->at('2026-10-26 17:00')));

        $this->ask('أجّل المهام المتأخرة إلى موعد جديد', 'ar')->assertOk()->assertJsonPath('intent', 'triage');
    }

    public function test_reflection_grounds_questions_in_the_week(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Ship release', 'priority' => 'urgent', 'status' => 'completed', 'completed_at' => now()->subDay()]);
        Task::factory()->overdue()->create(['user_id' => $this->user->id, 'title' => 'Old chore']);

        $response = $this->ask('Help me reflect on my week')->assertOk()->assertJsonPath('intent', 'reflection')->assertJsonPath('items.0.link', '/review');
        $this->assertStringContainsString('What helped you finish “Ship release”', $response->json('message'));
        $this->assertStringContainsString('slipped past their deadline', $response->json('message'));
        $this->ask('ساعدني على التأمل في أسبوعي', 'ar')->assertOk()->assertJsonPath('intent', 'reflection');
    }

    public function test_provider_interprets_queries_but_only_the_users_own_records_are_used(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        $mine = Project::factory()->create(['user_id' => $this->user->id, 'title' => 'Mine']);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'My task', 'project_id' => $mine->id]);
        $foreign = Project::factory()->create(['title' => 'Foreign']);
        Task::factory()->create(['user_id' => $foreign->user_id, 'title' => 'Foreign task', 'project_id' => $foreign->id]);
        $captured = null;
        $calls = 0;
        $reply = fn (array $data) => Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => json_encode($data + ['message' => 'Here you go.', 'schedule' => null, 'subtasks' => [], 'target' => null])]]]);
        Http::fake(['api.anthropic.com/*' => function (HttpRequest $request) use (&$captured, &$calls, $foreign, $mine, $reply) {
            $captured ??= $request;

            return $reply(['intent' => 'query', 'query' => ['entity' => 'tasks', 'due' => null, 'priority' => null, 'status' => null, 'project_id' => $calls++ === 0 ? $foreign->id : $mine->id, 'goal_id' => null]]);
        }]);

        $hostile = $this->ask('Show tasks for the Foreign project')->assertOk()->assertJsonPath('provider', 'anthropic')->assertJsonPath('intent', 'query');
        $this->assertStringNotContainsString('Foreign task', $hostile->getContent());
        $this->ask('Show tasks for project Mine')->assertOk()->assertJsonPath('tasks.0.title', 'My task');

        $input = json_decode($captured['messages'][0]['content'], true);
        $this->assertSame([['id' => $mine->id, 'title' => 'Mine']], $input['authorized_projects']);
        $this->assertStringNotContainsString('Foreign task', json_encode($input));
        $this->assertContains('goal_plan', $captured['output_config']['format']['schema']['properties']['intent']['enum']);
    }
}
