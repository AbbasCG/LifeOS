<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\PlanTemplate;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * V13: conversation search and export, and week-plan templates that become approvable proposals.
 */
class CopilotLibraryTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Monday 26 October 2026, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-10-26 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
    }

    private function send(string $message, ?string $conversation = null, array $extra = [], ?User $as = null): TestResponse
    {
        return $this->actingAs($as ?? $this->user)->postJson('/api/copilot/messages', ['message' => $message, 'language' => 'en', 'conversation_id' => $conversation] + $extra)->assertOk();
    }

    private function local(string $iso): CarbonImmutable
    {
        return CarbonImmutable::parse($iso)->setTimezone('Europe/Amsterdam');
    }

    public function test_search_finds_titles_and_messages_of_the_users_own_conversations(): void
    {
        $budget = $this->send('Why is my top task first?')->json('conversation.id');
        $this->send('And what about the quarterly budget review?', $budget);
        $this->send('Do I have any conflicts?');
        $other = User::factory()->create();
        $this->send('My budget secrets', null, [], $other);

        $r = $this->actingAs($this->user)->getJson('/api/copilot/conversations?q=BUDGET')->assertOk()->assertJsonCount(1, 'conversations')->assertJsonPath('conversations.0.id', $budget);
        $this->assertStringContainsString('quarterly budget review', $r->json('conversations.0.match'));
        $this->getJson('/api/copilot/conversations?q=conflicts')->assertJsonCount(1, 'conversations')->assertJsonPath('conversations.0.title', 'Do I have any conflicts?');
        $this->getJson('/api/copilot/conversations?q=%25')->assertJsonCount(0, 'conversations');
        $this->getJson('/api/copilot/conversations?q=secrets')->assertJsonCount(0, 'conversations');
        $this->getJson('/api/copilot/conversations?q='.str_repeat('a', 101))->assertStatus(422);
        $this->getJson('/api/copilot/conversations')->assertJsonCount(2, 'conversations');
    }

    public function test_export_downloads_markdown_or_json_and_is_private(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'estimated_minutes' => 240, 'status' => 'todo', 'due_at' => null]);
        $id = $this->send('Find two focus blocks this week')->json('conversation.id');

        $md = $this->actingAs($this->user)->get("/api/copilot/conversations/{$id}/export")->assertOk();
        $this->assertStringStartsWith('text/markdown', $md->headers->get('Content-Type'));
        $this->assertStringContainsString('attachment; filename="lifeos-conversation-2026-10-26-', $md->headers->get('Content-Disposition'));
        $body = $md->getContent();
        $this->assertStringContainsString('# Find two focus blocks this week', $body);
        $this->assertStringContainsString('## You', $body);
        $this->assertStringContainsString('Copilot (rule-based)', $body);
        $this->assertStringContainsString('**Proposal** (pending)', $body);
        $this->assertStringContainsString('create_event: Focus: Thesis', $body);

        $json = $this->get("/api/copilot/conversations/{$id}/export?format=json")->assertOk();
        $data = json_decode($json->getContent(), true);
        $this->assertSame($id, $data['conversation']['id']);
        $this->assertCount(2, $data['messages']);
        $this->assertArrayNotHasKey('client_id', $data['messages'][0]);

        $this->get("/api/copilot/conversations/{$id}/export?format=pdf")->assertStatus(422);
        $this->assertSame(2, AuditLog::where('user_id', $this->user->id)->where('action', 'conversation_exported')->count());
        $this->actingAs(User::factory()->create())->get("/api/copilot/conversations/{$id}/export")->assertNotFound();
    }

    public function test_a_proposal_saves_as_a_template_by_weekday_and_local_time(): void
    {
        $task = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'estimated_minutes' => 600, 'status' => 'todo', 'due_at' => null]);
        $r = $this->send('Find three focus blocks this week');
        $actions = $r->json('message.proposal.actions');

        $saved = $this->postJson('/api/copilot/templates', ['proposal_id' => $r->json('message.proposal.id'), 'name' => 'Deep week'])->assertCreated()->json('template');
        $this->assertSame('Deep week', $saved['name']);
        $this->assertCount(3, $saved['blocks']);
        $first = $this->local($actions[0]['starts_at']);
        $this->assertSame(['weekday' => $first->dayOfWeekIso, 'start' => $first->format('H:i'), 'minutes' => $actions[0]['minutes'], 'title' => $actions[0]['title'], 'task_id' => $task->id], $saved['blocks'][0]);
        $this->assertSame(1, AuditLog::where('action', 'plan_template_saved')->count());

        $this->postJson('/api/copilot/templates', ['proposal_id' => $r->json('message.proposal.id'), 'name' => 'Two', 'action_ids' => ['a1']])->assertCreated()->assertJsonCount(1, 'template.blocks');
        $this->getJson('/api/copilot/templates')->assertOk()->assertJsonCount(2, 'templates');

        $rebalance = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'rebalance', 'provider' => 'local', 'status' => 'pending', 'summary' => 'x', 'explanation' => [], 'actions' => [['id' => 'a1', 'type' => 'move_event', 'event_id' => 1, 'title' => 'x', 'starts_at' => now()->toIso8601String(), 'ends_at' => now()->toIso8601String(), 'minutes' => 0]], 'expires_at' => now()->addDay()]);
        $this->postJson('/api/copilot/templates', ['proposal_id' => $rebalance->id, 'name' => 'Moves'])->assertUnprocessable();
        $foreign = AssistantProposal::create(['user_id' => User::factory()->create()->id, 'kind' => 'focus_blocks', 'provider' => 'local', 'status' => 'pending', 'summary' => 'x', 'explanation' => [], 'actions' => $actions, 'expires_at' => now()->addDay()]);
        $this->postJson('/api/copilot/templates', ['proposal_id' => $foreign->id, 'name' => 'Theirs'])->assertNotFound();
        $this->postJson('/api/copilot/templates', ['proposal_id' => $r->json('message.proposal.id'), 'name' => str_repeat('x', 81)])->assertUnprocessable();
    }

    public function test_using_a_template_plans_the_same_days_and_times_and_skips_clashes(): void
    {
        $task = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'estimated_minutes' => 600, 'status' => 'todo', 'due_at' => null]);
        PlanTemplate::create(['user_id' => $this->user->id, 'name' => 'Deep week', 'blocks' => [
            ['weekday' => 1, 'start' => '09:00', 'minutes' => 90, 'title' => 'Focus: Thesis', 'task_id' => $task->id],
            ['weekday' => 3, 'start' => '10:00', 'minutes' => 60, 'title' => 'Writing', 'task_id' => null],
            ['weekday' => 5, 'start' => '14:00', 'minutes' => 60, 'title' => 'Review', 'task_id' => 999],
        ]]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Dentist', 'kind' => 'fixed', 'starts_at' => CarbonImmutable::parse('2026-11-04 10:30', 'Europe/Amsterdam')->utc(), 'ends_at' => CarbonImmutable::parse('2026-11-04 11:00', 'Europe/Amsterdam')->utc()]);

        $r = $this->send('Plan next week from my template Deep week')->assertJsonPath('message.intent', 'use_template')->assertJsonPath('message.proposal.kind', 'template')
            ->assertJsonPath('message.plan.impact.skipped', 1)->assertJsonPath('message.plan.conflicts.0.type', 'clash');
        $actions = collect($r->json('message.proposal.actions'));
        $this->assertSame(['2026-11-02 09:00', '2026-11-06 14:00'], $actions->map(fn ($a) => $this->local($a['starts_at'])->format('Y-m-d H:i'))->all());
        $this->assertSame([$task->id, null], $actions->pluck('task_id')->all(), 'links only to open tasks the user owns');
        $this->assertStringContainsString('Dentist', $r->json('message.plan.conflicts.0.detail'));
        $this->assertSame(1, CalendarEvent::count(), 'nothing is added before approval');

        $this->postJson("/api/assistant/proposals/{$r->json('message.proposal.id')}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertSame(2, CalendarEvent::count());

        $this->travelTo(CarbonImmutable::parse('2026-10-26 09:30', 'Europe/Amsterdam'));
        $thisWeek = $this->send('', $r->json('conversation.id'), ['choice' => ['type' => 'alternative', 'message_id' => $r->json('message.id'), 'value' => 'week:this']])
            ->assertJsonPath('message.state.slots.next_week', false)->assertJsonPath('message.plan.conflicts.0.type', 'past');
        $this->assertSame(['2026-10-28 10:00', '2026-10-30 14:00'], collect($thisWeek->json('message.proposal.actions'))->map(fn ($a) => $this->local($a['starts_at'])->format('Y-m-d H:i'))->all());
    }

    public function test_choosing_between_several_templates_and_managing_them(): void
    {
        PlanTemplate::create(['user_id' => $this->user->id, 'name' => 'Exam week', 'blocks' => [['weekday' => 2, 'start' => '09:00', 'minutes' => 60, 'title' => 'Revise', 'task_id' => null]]]);
        $calm = PlanTemplate::create(['user_id' => $this->user->id, 'name' => 'Calm week', 'blocks' => [['weekday' => 4, 'start' => '11:00', 'minutes' => 45, 'title' => 'Read', 'task_id' => null]]]);
        $theirs = PlanTemplate::create(['user_id' => User::factory()->create()->id, 'name' => 'Theirs', 'blocks' => []]);

        $q = $this->send('Use a template for next week')->assertJsonPath('message.clarify.slot', 'template');
        $this->assertEqualsCanonicalizing(['Exam week', 'Calm week'], collect($q->json('message.clarify.options'))->pluck('label.en')->all());
        $this->send('', $q->json('conversation.id'), ['choice' => ['type' => 'option', 'message_id' => $q->json('message.id'), 'value' => (string) $calm->id]])
            ->assertJsonPath('message.proposal.actions.0.title', 'Read')->assertJsonPath('user_message.content', 'Calm week');

        $this->patchJson("/api/copilot/templates/{$calm->id}", ['name' => 'Quiet week'])->assertOk()->assertJsonPath('template.name', 'Quiet week');
        $this->patchJson("/api/copilot/templates/{$theirs->id}", ['name' => 'Mine'])->assertNotFound();
        $this->deleteJson("/api/copilot/templates/{$theirs->id}")->assertNotFound();
        $this->deleteJson("/api/copilot/templates/{$calm->id}")->assertOk();
        $this->getJson('/api/copilot/templates')->assertJsonCount(1, 'templates')->assertJsonPath('templates.0.name', 'Exam week');

        PlanTemplate::where('user_id', $this->user->id)->delete();
        $this->send('Plan next week from my template')->assertJsonPath('message.proposal', null)->assertJsonPath('message.intent', 'use_template');
    }
}
