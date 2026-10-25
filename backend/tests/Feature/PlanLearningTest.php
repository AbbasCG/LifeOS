<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Goal;
use App\Models\Recommendation;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\IntelligenceSettings;
use App\Services\PlanLearning;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * V14: opening suggestions in Copilot, and opt-in learning of preferred plan versions.
 */
class PlanLearningTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Many chat turns per test: lift the per-minute Copilot limit for this suite only.
        config(['ai.provider' => 'disabled', 'ai.requests_per_minute' => 1000]);
        // Monday 26 October 2026, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-10-26 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'estimated_minutes' => 600, 'priority' => 'high', 'status' => 'todo', 'due_at' => null]);
    }

    private function send(string $message, ?string $conversation = null, array $extra = []): TestResponse
    {
        return $this->actingAs($this->user)->postJson('/api/copilot/messages', ['message' => $message, 'language' => 'en', 'conversation_id' => $conversation] + $extra)->assertOk();
    }

    private function choose(TestResponse $r, string $value): TestResponse
    {
        return $this->send('', $r->json('conversation.id'), ['choice' => ['type' => 'alternative', 'message_id' => $r->json('message.id'), 'value' => $value]]);
    }

    private function enable(): void
    {
        IntelligenceSettings::save($this->user, ['features' => ['plan_learning' => true]]);
    }

    public function test_learning_is_off_by_default_and_records_nothing(): void
    {
        foreach (range(1, 3) as $i) {
            $this->choose($this->send('Plan my week'), 'essentials');
        }
        $this->assertSame([], PlanLearning::counts($this->user));
        $this->send('Plan my week')->assertJsonPath('message.state.slots.alternative', 'balanced')->assertJsonMissingPath('message.plan.learned');
    }

    public function test_a_clear_preference_becomes_the_default_and_is_explained(): void
    {
        $this->enable();
        foreach (range(1, 2) as $i) {
            $this->choose($this->send('Plan my week'), 'essentials');
        }
        $this->send('Plan my week')->assertJsonPath('message.state.slots.alternative', 'balanced', 'two choices are not enough yet');
        $this->choose($this->send('Plan my week'), 'essentials');

        $r = $this->send('Plan my week')->assertJsonPath('message.state.slots.alternative', 'essentials')->assertJsonPath('message.plan.learned.week_version', 'essentials');
        $this->assertStringContainsString('Used what you usually choose: essentials only', implode(' ', $r->json('message.plan.explanation')));
        $this->assertSame('essentials', collect($r->json('message.plan.alternatives'))->firstWhere('current', true)['key']);

        // Switching back is still one click, and is learned too.
        $this->choose($r, 'balanced')->assertJsonPath('message.state.slots.alternative', 'balanced');
        $this->assertSame(['essentials' => 3, 'balanced' => 1], PlanLearning::counts($this->user)['week_version']);
    }

    public function test_applied_plans_and_follow_ups_are_learned_and_explicit_requests_win(): void
    {
        $this->enable();
        foreach (range(1, 3) as $i) {
            $r = $this->choose($this->send('Find two focus blocks this week'), 'long');
            $first = collect($r->json('message.proposal.actions'))->first();
            $this->postJson("/api/assistant/proposals/{$r->json('message.proposal.id')}/apply", ['action_ids' => [$first['id']]])->assertOk();
            CalendarEvent::query()->delete();
        }
        $this->assertSame(['long' => 6], PlanLearning::counts($this->user)['focus_length'], 'each choice and each applied plan counts');
        $this->send('Find two focus blocks this week')->assertJsonPath('message.state.slots.minutes', 90)->assertJsonPath('message.plan.learned.focus_length', 'long');
        $this->send('Find two 45 minute focus blocks this week')->assertJsonPath('message.state.slots.minutes', 45)->assertJsonMissingPath('message.plan.learned');

        foreach (range(1, 3) as $i) {
            $c = $this->send('Plan my week')->json('conversation.id');
            $this->send('don’t move anything', $c)->assertJsonPath('message.plan.moves.allowed', false);
        }
        $this->send('Plan my week')->assertJsonPath('message.plan.moves.allowed', false)->assertJsonPath('message.plan.learned.moves', 'off');
    }

    public function test_learning_can_be_inspected_forgotten_reset_and_deleted(): void
    {
        $this->enable();
        foreach (range(1, 3) as $i) {
            $this->choose($this->send('Plan my week'), 'essentials');
        }
        $this->getJson('/api/intelligence/settings')->assertOk()->assertJsonPath('settings.features.plan_learning', true)
            ->assertJsonPath('learning.dimensions.0', ['dimension' => 'week_version', 'counts' => ['essentials' => 3], 'total' => 3, 'shares' => ['essentials' => 100], 'preferred' => 'essentials', 'contexts' => []])
            ->assertJsonPath('learning.thresholds.count', 3);

        $this->deleteJson('/api/intelligence/learning')->assertOk()->assertJsonPath('cleared', 3);
        $this->assertSame([], PlanLearning::counts($this->user));
        $this->assertSame(1, AuditLog::where('action', 'plan_learning_reset')->count());

        PlanLearning::record($this->user, 'week_version', 'essentials');
        $this->postJson('/api/intelligence/reset-personalization')->assertOk();
        $this->assertSame([], PlanLearning::counts($this->user));

        PlanLearning::record($this->user, 'moves', 'off');
        PlanLearning::record($this->user, 'moves', 'sideways');
        $this->deleteJson('/api/intelligence/data')->assertOk()->assertJsonPath('deleted.plan_learning', 1);
        $this->assertSame([], PlanLearning::counts($this->user));
    }

    private function recommendation(string $type, array $payload): Recommendation
    {
        return Recommendation::create(['user_id' => $this->user->id, 'key' => $type.':'.uniqid(), 'type' => $type, 'severity' => 'medium', 'status' => 'active',
            'payload' => $payload + ['title' => ['en' => 'x', 'ar' => 'x']], 'first_seen_at' => now(), 'last_seen_at' => now()]);
    }

    public function test_suggestions_open_as_copilot_conversations_with_pending_proposals(): void
    {
        $thesis = Task::where('title', 'Thesis')->first();
        $deadline = $this->recommendation('deadline', ['subject' => ['task_id' => $thesis->id]]);
        $r = $this->actingAs($this->user)->postJson("/api/recommendations/{$deadline->id}/discuss", ['language' => 'en'])->assertCreated()
            ->assertJsonPath('user_message.content', 'Find time for “Thesis” before it’s due')->assertJsonPath('message.intent', 'find_time')
            ->assertJsonPath('message.proposal.status', 'pending')->assertJsonPath('message.provider', 'local');
        $conversation = Conversation::findOrFail($r->json('conversation.id'));
        $this->assertSame(2, ConversationMessage::where('conversation_id', $conversation->id)->count());
        $this->assertSame('acted', $deadline->fresh()->status);
        $this->assertSame($conversation->id, AssistantProposal::find($r->json('message.proposal.id'))->conversation_id);
        $this->assertSame(0, CalendarEvent::count(), 'nothing is applied');
        $this->getJson("/api/copilot/conversations/{$conversation->id}")->assertOk()->assertJsonCount(2, 'messages');

        $this->postJson('/api/recommendations/'.$this->recommendation('overload', ['subject' => ['date' => '2026-10-28']])->id.'/discuss', ['language' => 'en'])->assertCreated()
            ->assertJsonPath('user_message.content', 'My Wednesday is overloaded — plan my week around it')->assertJsonPath('message.intent', 'plan_week');
        $this->postJson('/api/recommendations/'.$this->recommendation('focus', ['subject' => ['task_id' => $thesis->id], 'evidence' => ['window' => ['minutes' => 75]]])->id.'/discuss', ['language' => 'ar'])->assertCreated()
            ->assertJsonPath('message.intent', 'focus_blocks')->assertJsonPath('message.state.slots.within', 'today')->assertJsonPath('conversation.language', 'ar');
        $goal = Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Run a marathon']);
        $this->postJson('/api/recommendations/'.$this->recommendation('goal', ['subject' => ['goal_id' => $goal->id], 'title' => ['en' => '“Run a marathon” needs attention', 'ar' => 'x']])->id.'/discuss', ['language' => 'en'])
            ->assertCreated()->assertJsonPath('user_message.content', 'Plan my goal Run a marathon')->assertJsonPath('message.intent', 'goal_plan');
        $this->postJson('/api/recommendations/'.$this->recommendation('conflict', ['subject' => ['date' => '2026-10-27']])->id.'/discuss', ['language' => 'en'])->assertCreated()->assertJsonPath('message.intent', 'conflicts');
        $this->assertSame(5, AuditLog::where('action', 'recommendation_discussed')->count());

        $this->postJson("/api/recommendations/{$deadline->id}/discuss", ['language' => 'en'])->assertUnprocessable();
        $theirs = Recommendation::create(['user_id' => User::factory()->create()->id, 'key' => 'k', 'type' => 'focus', 'severity' => 'low', 'status' => 'active', 'payload' => ['title' => ['en' => 'x', 'ar' => 'x']], 'first_seen_at' => now(), 'last_seen_at' => now()]);
        $this->postJson("/api/recommendations/{$theirs->id}/discuss", ['language' => 'en'])->assertNotFound();
        $this->postJson("/api/recommendations/{$theirs->id}/discuss", ['language' => 'fr'])->assertUnprocessable();
    }
}
