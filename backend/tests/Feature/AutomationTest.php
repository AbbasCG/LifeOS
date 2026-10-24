<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\AutomationRule;
use App\Models\AutomationRun;
use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\InboxNotification;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\AutomationEngine;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AutomationTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Monday 4 Jan 2027, 10:00 UTC.
        $this->travelTo(CarbonImmutable::parse('2027-01-04 10:00:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'break_minutes' => 10, 'work_days' => [1, 2, 3, 4, 5]]]);
    }

    private function rule(array $attributes): AutomationRule
    {
        $id = $this->actingAs($this->user)->postJson('/api/automations', $attributes + ['name' => 'Rule'])->assertCreated()->json('id');

        return AutomationRule::findOrFail($id);
    }

    public function test_crud_validates_catalogue_ownership_and_audits(): void
    {
        $this->actingAs($this->user)->postJson('/api/automations', ['name' => 'Bad', 'trigger' => 'task_overdue', 'action' => 'create_next_occurrence'])->assertUnprocessable()->assertJsonValidationErrors('action');
        $this->actingAs($this->user)->postJson('/api/automations', ['name' => 'Bad', 'trigger' => 'delete_all', 'action' => 'notify'])->assertUnprocessable();
        $this->actingAs($this->user)->postJson('/api/automations', ['name' => 'Bad', 'trigger' => 'task_overdue', 'action' => 'notify', 'conditions' => ['sql' => 'drop']])->assertUnprocessable();
        $this->actingAs($this->user)->postJson('/api/automations', ['name' => 'Bad', 'trigger' => 'task_overdue', 'action' => 'notify', 'conditions' => ['project_id' => 999]])->assertUnprocessable();

        $rule = $this->rule(['trigger' => 'task_overdue', 'action' => 'notify', 'conditions' => ['min_priority' => 'high']]);
        $this->actingAs($this->user)->getJson('/api/automations')->assertOk()->assertJsonCount(1, 'rules')->assertJsonCount(5, 'templates');
        $this->actingAs($this->user)->patchJson("/api/automations/{$rule->id}", ['enabled' => false])->assertOk()->assertJsonPath('enabled', false);

        $other = User::factory()->create();
        $this->actingAs($other)->patchJson("/api/automations/{$rule->id}", ['enabled' => true])->assertNotFound();
        $this->actingAs($other)->getJson("/api/automations/{$rule->id}/runs")->assertNotFound();
        $this->actingAs($other)->deleteJson("/api/automations/{$rule->id}")->assertNotFound();
        $this->assertSame(2, AuditLog::where('action', 'automation_changed')->count());
    }

    public function test_overdue_task_gets_one_time_block_suggestion_and_never_writes_the_calendar(): void
    {
        $this->rule(['trigger' => 'task_overdue', 'action' => 'suggest_time_block', 'conditions' => ['min_priority' => 'medium', 'overdue_hours' => 2]]);
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Tax return', 'priority' => 'high', 'estimated_minutes' => 60, 'due_at' => now()->subHours(5)]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Low prio', 'priority' => 'low', 'due_at' => now()->subHours(5)]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Just late', 'priority' => 'high', 'due_at' => now()->subHour()]);

        $this->artisan('lifeos:automations')->assertSuccessful();
        $this->artisan('lifeos:automations')->assertSuccessful();

        $this->assertSame(1, AutomationRun::where('status', 'succeeded')->count());
        $proposal = AssistantProposal::sole();
        $this->assertSame($task->id, $proposal->actions[0]['task_id']);
        $this->assertSame('pending', $proposal->status);
        $this->assertSame(0, CalendarEvent::count());
        $this->assertSame("/assistant?proposal={$proposal->id}", InboxNotification::where('kind', 'automation')->value('link'));
    }

    public function test_focus_completion_updates_progress_once(): void
    {
        $this->rule(['trigger' => 'focus_completed', 'action' => 'update_focus_stats', 'conditions' => ['min_minutes' => 10]]);
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Essay', 'status' => 'todo']);
        $session = $this->actingAs($this->user)->postJson('/api/focus-sessions', ['task_id' => $task->id, 'duration_seconds' => 1500, 'kind' => 'focus'])->assertCreated()->json();
        $this->travel(26)->minutes();

        $this->actingAs($this->user)->patchJson('/api/focus-sessions/'.($session['id'] ?? $session['data']['id']), ['action' => 'finish'])->assertOk();

        $this->assertSame('in_progress', $task->fresh()->status);
        $run = AutomationRun::sole();
        $this->assertSame('succeeded', $run->status);
        $this->assertSame(25, $run->result['minutes_today']);
        app(AutomationEngine::class)->fire($this->user, 'focus_completed', FocusSession::first());
        $this->assertSame(1, AutomationRun::count());
    }

    public function test_recurring_task_due_creates_a_single_future_next_occurrence(): void
    {
        $this->rule(['trigger' => 'recurring_task_due', 'action' => 'create_next_occurrence', 'conditions' => ['grace_hours' => 12]]);
        $missed = Task::create(['user_id' => $this->user->id, 'title' => 'Water plants', 'recurrence' => 'daily', 'status' => 'todo', 'due_at' => now()->subDays(3)]);

        $this->artisan('lifeos:automations')->assertSuccessful();
        $this->artisan('lifeos:automations')->assertSuccessful();

        $next = Task::where('title', 'Water plants')->where('id', '!=', $missed->id)->sole();
        $this->assertTrue($next->due_at->isFuture());
        $this->assertSame('todo', $missed->fresh()->status, 'The missed task is left for the user to decide');
        $this->assertSame(1, AutomationRun::count());
    }

    public function test_weekly_review_completion_drafts_next_week_plan_without_accepting_it(): void
    {
        $this->rule(['trigger' => 'weekly_review_completed', 'action' => 'offer_next_week_plan']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Prepare slides', 'priority' => 'high', 'estimated_minutes' => 90]);

        $this->actingAs($this->user)->postJson('/api/reviews/2027-01-04/complete', [])->assertOk();

        $proposal = ScheduleProposal::sole();
        $this->assertSame('2027-01-11', $proposal->starts_on->toDateString());
        $this->assertNull($proposal->accepted_at);
        $this->assertSame(0, CalendarEvent::count());
        $this->assertSame('Next week’s plan is ready to review', InboxNotification::where('kind', 'automation')->value('title'));
    }

    public function test_overloaded_day_suggests_rebalancing_and_preview_is_read_only(): void
    {
        $tomorrow = CarbonImmutable::parse('2027-01-05 00:00', 'UTC');
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'starts_at' => $tomorrow->setTime(9, 0), 'ends_at' => $tomorrow->setTime(14, 0), 'kind' => 'fixed']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Write report', 'starts_at' => $tomorrow->setTime(14, 0), 'ends_at' => $tomorrow->setTime(17, 0), 'kind' => 'flexible']);

        $preview = $this->actingAs($this->user)->postJson('/api/automations/preview', ['name' => 'x', 'trigger' => 'day_overloaded', 'action' => 'suggest_rebalance', 'conditions' => ['threshold' => 90, 'days_ahead' => 3]])
            ->assertOk()->assertJsonCount(1, 'matches')->assertJsonPath('matches.0.subject', '2027-01-05');
        $this->assertStringContainsString('approval', $preview->json('matches.0.description'));
        $this->assertSame(0, AssistantProposal::count());
        $this->assertSame(0, AutomationRun::count());

        $this->rule(['trigger' => 'day_overloaded', 'action' => 'suggest_rebalance', 'conditions' => ['threshold' => 90, 'days_ahead' => 3]]);
        $this->artisan('lifeos:automations')->assertSuccessful();
        $this->assertSame('move_event', AssistantProposal::sole()->actions[0]['type']);
        $this->assertSame('Write report', CalendarEvent::where('kind', 'flexible')->value('title'));
        $this->assertSame($tomorrow->setTime(14, 0)->getTimestamp(), CalendarEvent::where('kind', 'flexible')->first()->starts_at->getTimestamp(), 'Nothing moves until approved');
    }

    public function test_failures_are_logged_and_retried_safely_up_to_the_limit(): void
    {
        $rule = $this->rule(['trigger' => 'task_overdue', 'action' => 'suggest_time_block']);
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Fragile', 'priority' => 'high', 'due_at' => now()->subHours(3)]);
        $engine = app(AutomationEngine::class);
        $subject = ['key' => 'task:'.$task->id, 'label' => 'Fragile', 'model' => (object) ['id' => null]];
        $broken = new AutomationRule(['user_id' => $this->user->id, 'trigger' => 'task_overdue', 'action' => 'unknown_action']);
        $broken->id = $rule->id;
        $broken->setRelation('user', $this->user);

        for ($i = 0; $i < 5; $i++) {
            $engine->execute($broken, $subject);
        }

        $run = AutomationRun::sole();
        $this->assertSame('failed', $run->status);
        $this->assertSame(AutomationEngine::MAX_ATTEMPTS, $run->attempts);
        $this->assertNotNull($run->error);
        $this->actingAs($this->user)->getJson("/api/automations/{$rule->id}/runs")->assertOk()->assertJsonPath('data.0.status', 'failed');
        $this->actingAs($this->user)->getJson('/api/automations')->assertJsonPath('rules.0.failed_runs', 1);
    }

    public function test_disabled_rules_and_other_users_data_are_ignored(): void
    {
        $rule = $this->rule(['trigger' => 'task_overdue', 'action' => 'notify']);
        $rule->update(['enabled' => false]);
        $other = User::factory()->create();
        Task::create(['user_id' => $other->id, 'title' => 'Not yours', 'priority' => 'urgent', 'due_at' => now()->subDay()]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Mine', 'priority' => 'urgent', 'due_at' => now()->subDay()]);

        $this->artisan('lifeos:automations')->assertSuccessful();
        $this->assertSame(0, AutomationRun::count());

        $rule->update(['enabled' => true]);
        $this->artisan('lifeos:automations')->assertSuccessful();
        $this->assertSame(['Mine'], AutomationRun::pluck('subject')->all());
        $this->assertSame(0, InboxNotification::where('user_id', $other->id)->count());
    }

    public function test_rule_limit(): void
    {
        for ($i = 0; $i < AutomationEngine::MAX_RULES; $i++) {
            AutomationRule::create(['user_id' => $this->user->id, 'name' => "R{$i}", 'trigger' => 'task_overdue', 'action' => 'notify']);
        }
        $this->actingAs($this->user)->postJson('/api/automations', ['name' => 'One too many', 'trigger' => 'task_overdue', 'action' => 'notify'])->assertUnprocessable();
    }
}
