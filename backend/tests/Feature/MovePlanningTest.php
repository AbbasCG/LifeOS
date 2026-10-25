<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\ExternalEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * V11: Copilot plans may move the user's own flexible blocks (with a conflict preview), never fixed, recurring,
 * connected or written-back events, and only after approval.
 */
class MovePlanningTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private CalendarEvent $report;

    private CalendarEvent $workshop;

    private CalendarEvent $series;

    private CalendarEvent $synced;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Monday 26 October 2026, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-10-26 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        // Tuesday is fully booked: only "Write report" is movable.
        $this->workshop = $this->event('Client workshop', '2026-10-27 09:00', '2026-10-27 13:00', ['kind' => 'fixed']);
        $this->report = $this->event('Write report', '2026-10-27 13:00', '2026-10-27 15:00');
        $this->series = $this->event('Daily review', '2026-10-27 15:00', '2026-10-27 16:00', ['recurrence' => ['freq' => 'weekly'], 'timezone' => 'Europe/Amsterdam']);
        $this->synced = $this->event('Synced block', '2026-10-27 16:00', '2026-10-27 16:30');
        $google = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@gmail.com', 'access_token' => 'x', 'status' => 'active']);
        CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'calendar_event_id' => $this->synced->id, 'calendar_id' => 'primary', 'external_id' => 'copy1', 'title' => 'Synced block', 'starts_at' => $this->synced->starts_at, 'ends_at' => $this->synced->ends_at]);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'calendar_id' => 'primary', 'external_id' => 'ext1', 'title' => 'Google call', 'starts_at' => $this->at('2026-10-27 16:30'), 'ends_at' => $this->at('2026-10-27 17:00')]);
    }

    private function at(string $local): CarbonImmutable
    {
        return CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
    }

    /**
     * @param  array<string, mixed>  $extra
     */
    private function event(string $title, string $start, string $end, array $extra = []): CalendarEvent
    {
        return CalendarEvent::create($extra + ['user_id' => $this->user->id, 'title' => $title, 'kind' => 'flexible', 'starts_at' => $this->at($start), 'ends_at' => $this->at($end)]);
    }

    /**
     * @param  array<string, mixed>  $extra
     */
    private function send(string $message, ?string $conversation = null, array $extra = []): TestResponse
    {
        return $this->actingAs($this->user)->postJson('/api/copilot/messages', ['message' => $message, 'language' => 'en', 'conversation_id' => $conversation] + $extra)->assertOk();
    }

    /**
     * @return array{0: CarbonImmutable, 1: CarbonImmutable}
     */
    private function range(array $action): array
    {
        return [CarbonImmutable::parse($action['starts_at']), CarbonImmutable::parse($action['ends_at'])];
    }

    public function test_week_plan_moves_only_flexible_blocks_off_overloaded_days_with_a_preview(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Budget', 'estimated_minutes' => 240, 'priority' => 'high']);
        $r = $this->send('Plan my week around my meetings')->assertJsonPath('message.plan.moves.allowed', true)->assertJsonPath('message.plan.impact.moved_events', 1);
        $actions = collect($r->json('message.proposal.actions'));
        $moves = $actions->where('type', 'move_event')->values();

        $this->assertSame([$this->report->id], $moves->pluck('event_id')->all(), 'fixed, recurring, written-back and connected events never move');
        $this->assertSame('a1', $moves[0]['id'], 'moves come first');
        $this->assertSame([], $moves[0]['conflicts'], 'conflict preview is included');
        $this->assertStringContainsString('Write report', $moves[0]['reason']);
        [$to] = $this->range($moves[0]);
        $this->assertNotSame('2026-10-27', $to->setTimezone('Europe/Amsterdam')->toDateString());
        foreach ($actions->where('type', 'create_event') as $block) {
            [$s, $e] = $this->range($block);
            $this->assertFalse($s < CarbonImmutable::parse($moves[0]['ends_at']) && $e > $to, 'new blocks avoid where the move lands');
            $this->assertFalse($s < $this->report->ends_at && $e > $this->report->starts_at, 'freed time is not reused in the same proposal');
        }
        $this->assertSame($this->at('2026-10-27 13:00')->getTimestamp(), $this->report->fresh()->starts_at->getTimestamp(), 'nothing moves before approval');
    }

    public function test_a_move_applies_alone_and_undoes_and_never_touches_connected_calendars(): void
    {
        Http::fake();
        $r = $this->send('Plan my week');
        $id = $r->json('message.proposal.id');
        $move = collect($r->json('message.proposal.actions'))->firstWhere('type', 'move_event');

        $this->postJson("/api/assistant/proposals/{$id}/apply", ['action_ids' => [$move['id']]])->assertOk();
        $this->assertSame(CarbonImmutable::parse($move['starts_at'])->getTimestamp(), $this->report->fresh()->starts_at->getTimestamp());
        $this->assertSame(1, CalendarWriteLink::count());
        Http::assertNothingSent();
        foreach ([$this->workshop, $this->series, $this->synced] as $untouched) {
            $this->assertSame($untouched->starts_at->getTimestamp(), $untouched->fresh()->starts_at->getTimestamp());
        }

        $this->postJson("/api/assistant/proposals/{$id}/undo")->assertOk()->assertJsonPath('results.0.undo.done', true);
        $this->assertSame($this->at('2026-10-27 13:00')->getTimestamp(), $this->report->fresh()->starts_at->getTimestamp());
    }

    public function test_apply_refuses_moves_that_became_unsafe(): void
    {
        $r = $this->send('Plan my week');
        $move = collect($r->json('message.proposal.actions'))->firstWhere('type', 'move_event');
        CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => CalendarAccount::first()->id, 'calendar_event_id' => $this->report->id, 'calendar_id' => 'primary', 'external_id' => 'copy2', 'title' => 'Write report', 'starts_at' => $this->report->starts_at, 'ends_at' => $this->report->ends_at]);

        $this->postJson("/api/assistant/proposals/{$r->json('message.proposal.id')}/apply", ['action_ids' => [$move['id']]])->assertUnprocessable()->assertJsonFragment(['“Write report”: This event was copied to a connected calendar, so it is not moved from here.']);
        $this->assertSame($this->at('2026-10-27 13:00')->getTimestamp(), $this->report->fresh()->starts_at->getTimestamp());

        CalendarWriteLink::where('external_id', 'copy2')->delete();
        $this->report->update(['kind' => 'fixed']);
        $this->postJson("/api/assistant/proposals/{$r->json('message.proposal.id')}/apply", ['action_ids' => [$move['id']]])->assertUnprocessable();
    }

    public function test_keeping_everything_in_place_by_follow_up_or_choice(): void
    {
        $first = $this->send('Plan my week');
        $conversation = $first->json('conversation.id');

        $kept = $this->send('don’t move anything', $conversation)->assertJsonPath('message.plan.moves.allowed', false)->assertJsonPath('message.plan.moves.available', 1)
            ->assertJsonPath('message.state.slots.moves', false);
        $this->assertNotContains('move_event', collect($kept->json('message.proposal.actions'))->pluck('type')->all());
        $this->assertSame('dismissed', AssistantProposal::find($first->json('message.proposal.id'))->status);

        $this->send('', $conversation, ['choice' => ['type' => 'alternative', 'message_id' => $kept->json('message.id'), 'value' => 'moves:on']])
            ->assertJsonPath('user_message.content', 'Move flexible blocks if needed')->assertJsonPath('message.plan.moves.count', 1);
        $this->actingAs($this->user)->postJson('/api/copilot/messages', ['language' => 'en', 'conversation_id' => $conversation, 'choice' => ['type' => 'alternative', 'message_id' => $kept->json('message.id'), 'value' => 'moves:sideways']])->assertStatus(422);

        $this->send('Plan my week but keep everything in place')->assertJsonPath('message.plan.moves.allowed', false);
    }

    public function test_reorganizing_after_an_interruption_moves_caught_blocks_later(): void
    {
        $inbox = $this->event('Inbox zero', '2026-10-26 09:00', '2026-10-26 10:00');
        $dentist = $this->event('Dentist', '2026-10-26 10:00', '2026-10-26 10:30', ['kind' => 'fixed']);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Slides', 'estimated_minutes' => 120, 'priority' => 'high', 'due_at' => $this->at('2026-10-26 17:00')]);

        $r = $this->send('Reorganize today, I am busy until 11')->assertJsonPath('message.intent', 'reorganize_day')->assertJsonPath('message.plan.impact.moved_events', 1);
        $actions = collect($r->json('message.proposal.actions'));
        $move = $actions->firstWhere('type', 'move_event');
        $this->assertSame($inbox->id, $move['event_id']);
        [$to, $end] = $this->range($move);
        $this->assertTrue($to->gte($this->at('2026-10-26 11:00')), 'after the interruption');
        foreach ($actions->where('type', 'create_event') as $block) {
            [$s, $e] = $this->range($block);
            $this->assertFalse($s < $end && $e > $to, 'new blocks avoid the moved block');
        }
        $this->assertNotContains($dentist->id, $actions->pluck('event_id')->filter()->all());

        $this->postJson("/api/assistant/proposals/{$r->json('message.proposal.id')}/apply", ['action_ids' => $actions->pluck('id')->all()])->assertOk();
        $this->assertSame($to->getTimestamp(), $inbox->fresh()->starts_at->getTimestamp());
        $this->assertSame($this->at('2026-10-26 10:00')->getTimestamp(), $dentist->fresh()->starts_at->getTimestamp());
    }

    public function test_rebalance_no_longer_moves_written_back_events(): void
    {
        $this->report->delete();
        $this->actingAs($this->user)->postJson('/api/assistant', ['message' => 'My week is too busy, rebalance it', 'language' => 'en'])->assertOk()
            ->assertJsonPath('intent', 'rebalance')->assertJsonPath('proposal.status', 'dismissed');
    }

    public function test_provider_can_ask_to_keep_events_in_place(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        Http::fake(['api.anthropic.com/*' => Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => json_encode(['message' => 'Planning.', 'intent' => 'plan_week', 'subtasks' => [], 'schedule' => null, 'query' => null, 'target' => null, 'clarification_options' => [],
            'plan' => ['priorities' => [], 'next_week' => false, 'count' => null, 'minutes' => null, 'within' => null, 'busy_until' => null, 'lost_minutes' => null, 'moves' => false]])]]])]);

        $this->send('Plan my week, leave my calendar alone')->assertJsonPath('message.provider', 'anthropic')->assertJsonPath('message.plan.moves.allowed', false)->assertJsonPath('message.plan.moves.count', 0);
    }
}
