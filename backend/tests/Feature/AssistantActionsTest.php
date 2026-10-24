<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class AssistantActionsTest extends TestCase
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

    public function test_four_hour_request_proposes_blocks_around_existing_events_without_changing_data(): void
    {
        Http::fake();
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Dentist', 'starts_at' => CarbonImmutable::parse('2026-10-25 11:00', 'Europe/Amsterdam')->utc(), 'ends_at' => CarbonImmutable::parse('2026-10-25 12:00', 'Europe/Amsterdam')->utc(), 'kind' => 'fixed']);

        $response = $this->ask('I have four hours available tomorrow. Schedule studying, programming, and exercise.')
            ->assertOk()
            ->assertJsonPath('provider', 'local')
            ->assertJsonPath('intent', 'schedule')
            ->assertJsonPath('proposal.status', 'pending')
            ->assertJsonCount(3, 'proposal.actions');

        $actions = collect($response->json('proposal.actions'));
        $this->assertSame(['Studying', 'Programming', 'Exercise'], $actions->pluck('title')->all());
        $this->assertLessThanOrEqual(240, $actions->sum('minutes'));
        $dentist = [CarbonImmutable::parse('2026-10-25 10:00'), CarbonImmutable::parse('2026-10-25 11:00')];
        foreach ($actions as $action) {
            $start = CarbonImmutable::parse($action['starts_at']);
            $end = CarbonImmutable::parse($action['ends_at']);
            $this->assertSame('2026-10-25', $start->setTimezone('Europe/Amsterdam')->toDateString());
            $this->assertFalse($start < $dentist[1] && $end > $dentist[0], 'Block overlaps the dentist appointment');
        }
        $this->assertNotEmpty($response->json('proposal.explanation'));
        $this->assertSame(1, CalendarEvent::count(), 'Proposing must not create events');
        Http::assertNothingSent();
    }

    public function test_only_approved_actions_are_executed_and_audited(): void
    {
        $proposal = $this->ask('I have four hours available tomorrow. Schedule studying, programming, and exercise.')->json('proposal');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1', 'a3']])
            ->assertOk()
            ->assertJsonPath('status', 'applied')
            ->assertJsonCount(2, 'results');

        $this->assertEqualsCanonicalizing(['Studying', 'Exercise'], CalendarEvent::pluck('title')->all());
        $this->assertSame('flexible', CalendarEvent::first()->kind);
        $this->assertSame(1, AuditLog::where('action', 'ai_action_executed')->count());

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a2']])->assertUnprocessable();
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_apply_rechecks_conflicts_and_changes_nothing_when_one_action_fails(): void
    {
        $proposal = $this->ask('I have four hours available tomorrow. Schedule studying, programming, and exercise.')->json('proposal');
        $second = $proposal['actions'][1];
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Call with Sam', 'starts_at' => $second['starts_at'], 'ends_at' => $second['ends_at'], 'kind' => 'fixed']);

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1', 'a2', 'a3']])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('actions');

        $this->assertSame(['Call with Sam'], CalendarEvent::pluck('title')->all());
        $this->assertSame('pending', AssistantProposal::first()->status);
    }

    public function test_unknown_action_ids_and_other_users_proposals_are_rejected(): void
    {
        $proposal = $this->ask('Schedule reading tomorrow')->json('proposal');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a9']])->assertUnprocessable();
        $this->actingAs(User::factory()->create())->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertNotFound();
        $this->actingAs(User::factory()->create())->getJson("/api/assistant/proposals/{$proposal['id']}")->assertNotFound();
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_tampered_actions_are_never_executed(): void
    {
        $proposal = AssistantProposal::create([
            'user_id' => $this->user->id, 'kind' => 'schedule', 'provider' => 'openai', 'summary' => 'x', 'explanation' => [], 'expires_at' => now()->addHour(),
            'actions' => [['id' => 'a1', 'type' => 'delete_everything', 'title' => 'Bad', 'starts_at' => now()->addDay()->toIso8601String(), 'ends_at' => now()->addDay()->addHour()->toIso8601String()]],
        ]);

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1']])->assertUnprocessable();
        $this->assertSame('pending', $proposal->fresh()->status);
    }

    public function test_expired_and_dismissed_proposals_cannot_be_applied(): void
    {
        $proposal = $this->ask('Schedule reading tomorrow')->json('proposal');
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/dismiss")->assertOk()->assertJsonPath('status', 'dismissed');
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertUnprocessable();

        $next = $this->ask('Schedule reading tomorrow')->json('proposal');
        $this->travel(25)->hours();
        $this->actingAs($this->user)->getJson("/api/assistant/proposals/{$next['id']}")->assertJsonPath('status', 'expired');
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$next['id']}/apply", ['action_ids' => ['a1']])->assertUnprocessable();
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_activities_link_to_matching_tasks(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Thesis chapter', 'estimated_minutes' => 90]);

        $action = $this->ask('Block time for thesis chapter on Monday after 13:00')->json('proposal.actions.0');

        $this->assertSame($task->id, $action['task_id']);
        $this->assertSame('Thesis chapter', $action['title']);
        $this->assertSame('2026-10-26 13:00', CarbonImmutable::parse($action['starts_at'])->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));
    }

    public function test_arabic_scheduling_request(): void
    {
        $this->ask('لدي أربع ساعات متاحة غداً. جدول الدراسة والبرمجة والرياضة.', 'ar')
            ->assertOk()
            ->assertJsonPath('intent', 'schedule')
            ->assertJsonCount(3, 'proposal.actions')
            ->assertJsonPath('proposal.actions.0.title', 'الدراسة');
    }

    public function test_rebalance_moves_only_flexible_lifeos_blocks_off_overloaded_days(): void
    {
        $monday = CarbonImmutable::parse('2026-10-26', 'Europe/Amsterdam');
        $at = fn (int $h) => $monday->setTime($h, 0)->utc();
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'starts_at' => $at(9), 'ends_at' => $at(14), 'kind' => 'fixed']);
        $flex = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Write report', 'starts_at' => $at(14), 'ends_at' => $at(17), 'kind' => 'flexible']);

        $proposal = $this->ask('My week is overloaded, can you rebalance?')->assertJsonPath('intent', 'rebalance')->json('proposal');

        $this->assertCount(1, $proposal['actions']);
        $this->assertSame('move_event', $proposal['actions'][0]['type']);
        $this->assertSame($flex->id, $proposal['actions'][0]['event_id']);
        $this->assertNotSame('2026-10-26', CarbonImmutable::parse($proposal['actions'][0]['starts_at'])->setTimezone('Europe/Amsterdam')->toDateString());

        $flex->update(['starts_at' => $at(13)]);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertUnprocessable();
        $flex->update(['starts_at' => $at(14)]);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertSame(CarbonImmutable::parse($proposal['actions'][0]['starts_at'])->getTimestamp(), $flex->fresh()->starts_at->getTimestamp());
    }

    public function test_anthropic_provider_interprets_but_server_computes_the_schedule(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        $captured = null;
        Http::fake(['api.anthropic.com/*' => function (HttpRequest $request) use (&$captured) {
            $captured = $request;

            return Http::response(['stop_reason' => 'end_turn', 'content' => [
                ['type' => 'thinking', 'thinking' => ''],
                ['type' => 'text', 'text' => json_encode(['message' => 'Here is a balanced plan.', 'intent' => 'schedule', 'subtasks' => [], 'schedule' => ['date' => '2026-10-25', 'available_minutes' => 120, 'start_after' => '14:00', 'items' => [['title' => 'Studying', 'minutes' => 60, 'task_id' => 999999], ['title' => 'Exercise', 'minutes' => null, 'task_id' => null]]]])],
            ]]);
        }]);

        $response = $this->ask('Plan two hours for studying and exercise tomorrow afternoon')->assertOk()
            ->assertJsonPath('provider', 'anthropic')
            ->assertJsonPath('proposal.provider', 'anthropic')
            ->assertJsonCount(2, 'proposal.actions')
            ->assertJsonPath('proposal.actions.0.task_id', null);

        $this->assertSame('2026-10-25 14:00', CarbonImmutable::parse($response->json('proposal.actions.0.starts_at'))->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));
        $this->assertSame('test-key', $captured->header('x-api-key')[0]);
        $this->assertSame('claude-opus-5-5', $captured['model']);
        $this->assertSame('json_schema', $captured['output_config']['format']['type']);
        $this->assertSame(0, CalendarEvent::count());
        $this->assertStringNotContainsString('test-key', $response->getContent());
    }

    public function test_provider_output_outside_the_schema_falls_back_to_local(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        Http::fake(['api.anthropic.com/*' => Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => json_encode(['message' => 'x', 'intent' => 'drop_tables', 'subtasks' => [], 'schedule' => null])]]])]);

        $this->ask('How was my week?')->assertOk()->assertJsonPath('provider', 'local')->assertJsonStructure(['notice']);
    }

    public function test_refusals_fall_back_to_local(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        Http::fake(['api.anthropic.com/*' => Http::response(['stop_reason' => 'refusal', 'content' => []])]);

        $this->ask('How was my week?')->assertOk()->assertJsonPath('provider', 'local');
    }

    public function test_users_can_opt_out_of_external_ai_and_status_hides_keys(): void
    {
        config(['ai.provider' => 'openai', 'ai.providers.openai.key' => 'sk-secret']);
        Http::fake();
        $this->actingAs($this->user)->getJson('/api/assistant/status')->assertOk()->assertJsonPath('active.provider', 'openai')->assertJsonMissingPath('providers.0.key');
        $this->actingAs($this->user)->putJson('/api/settings', ['assistant_external' => false])->assertOk();

        $status = $this->actingAs($this->user)->getJson('/api/assistant/status')->assertJsonPath('active.provider', 'local')->assertJsonPath('external_allowed', false);
        $this->assertStringNotContainsString('sk-secret', $status->getContent());
        $this->ask('help')->assertJsonPath('provider', 'local');
        Http::assertNothingSent();
    }

    public function test_pending_proposals_are_listed_for_their_owner_only(): void
    {
        $proposal = $this->ask('Schedule reading tomorrow')->json('proposal');

        $this->actingAs($this->user)->getJson('/api/assistant/proposals')->assertOk()->assertJsonCount(1)->assertJsonPath('0.id', $proposal['id']);
        $this->actingAs(User::factory()->create())->getJson('/api/assistant/proposals')->assertOk()->assertJsonCount(0);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/dismiss")->assertOk();
        $this->actingAs($this->user)->getJson('/api/assistant/proposals')->assertJsonCount(0);
    }
}
