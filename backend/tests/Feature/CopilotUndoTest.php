<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class CopilotUndoTest extends TestCase
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
        $this->actingAs($this->user);
    }

    private function scheduled(): array
    {
        $proposal = $this->postJson('/api/assistant', ['message' => 'I have four hours available tomorrow. Schedule studying, programming, and exercise.', 'language' => 'en'])->json('proposal');
        $this->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1', 'a2', 'a3']])->assertOk()->assertJsonPath('undo_until', fn ($v) => $v !== null);

        return $proposal;
    }

    private function undo(string $id): TestResponse
    {
        return $this->postJson("/api/assistant/proposals/{$id}/undo");
    }

    public function test_undo_removes_created_blocks_once_and_is_audited(): void
    {
        $proposal = $this->scheduled();
        $this->assertSame(3, CalendarEvent::count());

        $this->undo($proposal['id'])->assertOk()->assertJsonPath('status', 'undone')->assertJsonPath('undo_until', null)
            ->assertJsonPath('results.0.undo.done', true);
        $this->assertSame(0, CalendarEvent::count());
        $this->assertSame(['proposal' => $proposal['id'], 'kind' => 'schedule', 'reversed' => 3, 'kept' => 0], AuditLog::where('action', 'ai_action_undone')->sole()->meta);

        $this->undo($proposal['id'])->assertUnprocessable();
        $this->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertUnprocessable();
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_changes_the_user_made_since_are_kept_and_reported(): void
    {
        $proposal = $this->scheduled();
        $events = CalendarEvent::orderBy('starts_at')->get();
        $events[0]->update(['title' => 'Studying — chapter 3']);
        $events[1]->update(['starts_at' => $events[1]->starts_at->addMinutes(30), 'ends_at' => $events[1]->ends_at->addMinutes(30)]);

        $results = collect($this->undo($proposal['id'])->assertOk()->json('results'));
        $this->assertSame([false, false, true], $results->pluck('undo.done')->all());
        $this->assertSame(['changed since', 'changed since'], $results->pluck('undo.reason')->filter()->values()->all());
        $this->assertEqualsCanonicalizing([$events[0]->id, $events[1]->id], CalendarEvent::pluck('id')->all());
    }

    public function test_moves_are_restored_unless_the_original_time_is_taken(): void
    {
        $monday = CarbonImmutable::parse('2026-10-26', 'Europe/Amsterdam');
        $at = fn (int $h) => $monday->setTime($h, 0)->utc();
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'starts_at' => $at(9), 'ends_at' => $at(14), 'kind' => 'fixed']);
        $flex = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Write report', 'starts_at' => $at(14), 'ends_at' => $at(17), 'kind' => 'flexible']);
        $rebalance = fn () => $this->postJson('/api/assistant', ['message' => 'My week is overloaded, can you rebalance?', 'language' => 'en'])->assertJsonPath('intent', 'rebalance')->json('proposal');

        $first = $rebalance();
        $this->postJson("/api/assistant/proposals/{$first['id']}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertFalse($flex->fresh()->starts_at->equalTo($at(14)));
        $this->undo($first['id'])->assertOk()->assertJsonPath('results.0.undo.done', true);
        $this->assertTrue($flex->fresh()->starts_at->equalTo($at(14)));

        $second = $rebalance();
        $this->postJson("/api/assistant/proposals/{$second['id']}/apply", ['action_ids' => ['a1']])->assertOk();
        $moved = $flex->fresh()->starts_at;
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Client call', 'starts_at' => $at(15), 'ends_at' => $at(16), 'kind' => 'fixed']);
        $this->undo($second['id'])->assertOk()->assertJsonPath('results.0.undo', ['done' => false, 'reason' => 'original time is taken']);
        $this->assertTrue($flex->fresh()->starts_at->equalTo($moved), 'never moved into a conflict');
    }

    public function test_created_tasks_are_removed_only_while_untouched_and_deadlines_are_restored(): void
    {
        $late = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tax filing', 'status' => 'todo', 'due_at' => now()->subDay()]);
        $actions = [
            ['id' => 'a1', 'type' => 'create_task', 'title' => 'Outline', 'priority' => 'medium', 'estimated_minutes' => 30, 'due_at' => null, 'goal_id' => null],
            ['id' => 'a2', 'type' => 'create_task', 'title' => 'Draft', 'priority' => 'medium', 'estimated_minutes' => 60, 'due_at' => null, 'goal_id' => null],
            ['id' => 'a3', 'type' => 'reschedule_task', 'title' => 'Tax filing', 'task_id' => $late->id, 'from_due_at' => $late->due_at->toIso8601String(), 'due_at' => now()->addDays(2)->utc()->toIso8601String()],
        ];
        $proposal = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'goal_plan', 'provider' => 'local', 'status' => 'pending', 'summary' => 'Plan', 'explanation' => [], 'actions' => $actions, 'expires_at' => now()->addHour()]);
        $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1', 'a2', 'a3']])->assertOk();
        $draft = Task::where('title', 'Draft')->sole();
        FocusSession::create(['user_id' => $this->user->id, 'task_id' => $draft->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 1500, 'elapsed_seconds' => 1500, 'started_at' => now(), 'completed_at' => now()->addMinutes(25)]);

        $results = collect($this->undo($proposal->id)->assertOk()->json('results'));
        $this->assertSame([true, false, true], $results->pluck('undo.done')->all());
        $this->assertSame('in use since', $results[1]['undo']['reason']);
        $this->assertSame(['Draft', 'Tax filing'], Task::orderBy('title')->pluck('title')->all());
        $this->assertTrue($late->fresh()->due_at->equalTo($late->due_at));
    }

    public function test_undo_window_legacy_proposals_and_other_users(): void
    {
        $proposal = $this->scheduled();
        $legacy = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'schedule', 'provider' => 'local', 'status' => 'applied', 'applied_at' => now(), 'summary' => 'Old', 'explanation' => [], 'actions' => [], 'results' => [['action_id' => 'a1', 'type' => 'create_event', 'event_id' => 1]], 'expires_at' => now()]);
        $this->getJson("/api/assistant/proposals/{$legacy->id}")->assertOk()->assertJsonPath('undo_until', null);
        $this->undo($legacy->id)->assertUnprocessable();

        $this->actingAs(User::factory()->create());
        $this->undo($proposal['id'])->assertNotFound();
        $this->actingAs($this->user);

        $this->travel(25)->hours();
        $this->getJson("/api/assistant/proposals/{$proposal['id']}")->assertOk()->assertJsonPath('undo_until', null);
        $this->undo($proposal['id'])->assertUnprocessable()->assertJsonPath('errors.proposal.0', 'These changes can no longer be undone.');
        $this->assertSame(3, CalendarEvent::count());
    }
}
