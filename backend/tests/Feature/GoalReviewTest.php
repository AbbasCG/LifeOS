<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\GoalReview;
use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\IntelligenceSettings;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * V18: monthly goal reviews with a proposed next step, on demand and (opt-in) on the 1st of each month.
 */
class GoalReviewTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private Goal $marathon;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled', 'ai.requests_per_minute' => 1000]);
        // Tuesday 20 October 2026, 10:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-10-20 10:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        $this->marathon = Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Run a marathon', 'target' => 100, 'progress' => 40, 'due_at' => now()->addMonths(5),
            'milestones' => [['title' => '10 km run', 'completed' => true], ['title' => 'Half marathon', 'completed' => false]]]);
        $done = Task::factory()->create(['user_id' => $this->user->id, 'goal_id' => $this->marathon->id, 'title' => 'Buy shoes', 'status' => 'completed', 'completed_at' => now()->subDays(5), 'estimated_minutes' => 30]);
        Task::factory()->create(['user_id' => $this->user->id, 'goal_id' => $this->marathon->id, 'title' => 'Long run', 'status' => 'todo', 'priority' => 'high', 'estimated_minutes' => 90, 'due_at' => now()->addDays(3)]);
        Task::factory()->create(['user_id' => $this->user->id, 'goal_id' => $this->marathon->id, 'title' => 'Old training', 'status' => 'completed', 'completed_at' => now()->subMonths(2), 'estimated_minutes' => 30]);
        FocusSession::factory()->create(['user_id' => $this->user->id, 'task_id' => $done->id, 'status' => 'completed', 'kind' => 'focus', 'elapsed_seconds' => 45 * 60, 'completed_at' => now()->subDays(5)]);
    }

    public function test_a_goal_review_states_the_month_and_proposes_time_for_open_tasks_without_applying_anything(): void
    {
        $r = $this->actingAs($this->user)->postJson("/api/goals/{$this->marathon->id}/review", ['language' => 'en'])->assertCreated()
            ->assertJsonPath('user_message.content', 'Review my goal “Run a marathon” this month')->assertJsonPath('message.intent', 'goal_review')
            ->assertJsonPath('message.proposal.kind', 'find_time')->assertJsonPath('message.proposal.status', 'pending');
        $text = $r->json('message.content');
        $this->assertStringContainsString('Review of “Run a marathon” — October 2026', $text);
        $this->assertStringContainsString('Progress: 40%. This is the first review', $text);
        $this->assertStringContainsString('1 linked task(s) completed and 45 focus minute(s) on them.', $text, 'only this month counts');
        $this->assertStringContainsString('Milestones: 1 of 2.', $text);
        $this->assertStringContainsString('Open now: 1 task(s).', $text);
        $this->assertStringContainsString('To finish on time: about 12% a month', $text);
        $this->assertSame('Long run', collect($r->json('message.proposal.actions'))->first()['title'] ?? null);
        $this->assertSame(0, CalendarEvent::count(), 'nothing is written');

        $snapshot = GoalReview::sole();
        $this->assertSame(['2026-10-01', 40, 1, 45], [$snapshot->period_start->toDateString(), $snapshot->percent, $snapshot->tasks_done, $snapshot->focus_minutes]);
        $this->assertSame(['scheduled' => false, 'proposal' => true], AuditLog::where('action', 'goal_reviewed')->sole()->meta);

        // A month later the review shows the change since this one.
        $this->marathon->update(['progress' => 55]);
        $this->travelTo(CarbonImmutable::parse('2026-11-18 10:00', 'Europe/Amsterdam'));
        $next = $this->postJson("/api/goals/{$this->marathon->id}/review", ['language' => 'ar'])->assertCreated()->json('message.content');
        $this->assertStringContainsString('التقدم: 55٪ (+15٪ منذ مراجعة', $next);
        $this->assertStringContainsString("«\u{2068}Run a marathon\u{2069}»", $next, 'an English title keeps its direction inside Arabic text');
        $this->assertSame(2, GoalReview::count());
    }

    public function test_a_goal_without_open_tasks_gets_dated_tasks_and_a_completed_goal_gets_no_proposal(): void
    {
        Task::where('title', 'Long run')->update(['status' => 'completed', 'completed_at' => now()]);
        $this->actingAs($this->user)->postJson("/api/goals/{$this->marathon->id}/review", ['language' => 'en'])->assertCreated()
            ->assertJsonPath('message.proposal.kind', 'goal_plan')->assertJsonPath('message.proposal.actions.0.title', 'Half marathon');

        $this->marathon->update(['progress' => 100]);
        $r = $this->postJson("/api/goals/{$this->marathon->id}/review", ['language' => 'en'])->assertCreated()->assertJsonPath('message.proposal', null);
        $this->assertStringContainsString('Target reached — no next step proposed.', $r->json('message.content'));
    }

    public function test_reviews_can_be_asked_for_in_chat_and_are_private(): void
    {
        $this->actingAs($this->user)->postJson('/api/copilot/messages', ['message' => 'How is my progress on my marathon goal?', 'language' => 'en'])->assertOk()
            ->assertJsonPath('message.intent', 'goal_review')->assertJsonPath('message.proposal.kind', 'find_time');

        $other = Goal::factory()->create(['user_id' => User::factory()->create()->id]);
        $this->postJson("/api/goals/{$other->id}/review", ['language' => 'en'])->assertNotFound();
        $this->postJson("/api/goals/{$this->marathon->id}/review", ['language' => 'de'])->assertUnprocessable();

        $this->deleteJson('/api/intelligence/data')->assertOk()->assertJsonPath('deleted.goal_reviews', 1);
        $this->assertSame(0, GoalReview::count());
    }

    public function test_the_monthly_review_is_opt_in_prepared_once_on_the_first_and_opens_each_goal(): void
    {
        $quiet = Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Read 12 books', 'target' => 12, 'progress' => 3, 'due_at' => null]);
        Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Done goal', 'target' => 10, 'progress' => 10, 'due_at' => null]);
        $this->travelTo(CarbonImmutable::parse('2026-11-01 10:00', 'Europe/Amsterdam'));
        $this->artisan('lifeos:goal-reviews')->assertSuccessful();
        $this->assertSame(0, Conversation::count(), 'off by default');

        IntelligenceSettings::save($this->user, ['features' => ['goal_reviews' => true]]);
        $this->travelTo(CarbonImmutable::parse('2026-11-01 08:30', 'Europe/Amsterdam'));
        $this->artisan('lifeos:goal-reviews')->assertSuccessful();
        $this->assertSame(0, Conversation::count(), 'not before 09:00');
        $this->travelTo(CarbonImmutable::parse('2026-11-01 09:10', 'Europe/Amsterdam'));
        $this->artisan('lifeos:goal-reviews')->assertSuccessful();
        $this->artisan('lifeos:goal-reviews')->assertSuccessful();

        $conversation = Conversation::sole();
        $this->assertSame('Monthly goal review (October 2026)', $conversation->title);
        $overview = ConversationMessage::where('conversation_id', $conversation->id)->where('role', 'assistant')->sole();
        $this->assertStringContainsString('“Run a marathon”: 40% · on track · 1 task(s) · 45 focus min', $overview->content);
        $this->assertStringContainsString('“Read 12 books”: 25% · no deadline', $overview->content);
        $this->assertStringNotContainsString('Done goal', $overview->content);
        $this->assertSame(['Review “Run a marathon”', 'Review “Read 12 books”'], collect($overview->payload['clarify']['options'])->pluck('label.en')->all());
        $this->assertSame(0, AssistantProposal::count(), 'the overview proposes nothing by itself');
        $this->assertSame(2, GoalReview::whereDate('period_start', '2026-10-01')->count());
        $note = InboxNotification::where('kind', 'goal_review')->sole();
        $this->assertSame(['review', 'Your goal review for October 2026 is ready', "/assistant?c={$conversation->id}"], [$note->category, $note->title, $note->link]);

        // Picking a goal opens its full review for October, with a proposed next step.
        $r = $this->actingAs($this->user)->postJson('/api/copilot/messages', ['conversation_id' => $conversation->id, 'language' => 'en', 'message' => '',
            'choice' => ['type' => 'option', 'message_id' => $overview->id, 'value' => (string) $quiet->id]])->assertOk()
            ->assertJsonPath('user_message.content', 'Review “Read 12 books”')->assertJsonPath('message.intent', 'goal_review')->assertJsonPath('message.proposal.kind', 'goal_plan');
        $this->assertStringContainsString('Review of “Read 12 books” — October 2026', $r->json('message.content'));
        $this->postJson('/api/copilot/messages', ['conversation_id' => $conversation->id, 'language' => 'en', 'message' => '',
            'choice' => ['type' => 'option', 'message_id' => $overview->id, 'value' => '999999']])->assertUnprocessable();

        // Next month again.
        $this->travelTo(CarbonImmutable::parse('2026-12-01 09:30', 'Europe/Amsterdam'));
        $this->artisan('lifeos:goal-reviews')->assertSuccessful();
        $this->assertSame(2, Conversation::where('title', 'like', 'Monthly goal review%')->count());
    }
}
