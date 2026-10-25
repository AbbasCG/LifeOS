<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\Recommendation;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class AiControlCenterTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Monday 22 March 2027, 07:00 UTC.
        $this->travelTo(CarbonImmutable::parse('2027-03-22 07:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'focus_block_minutes' => 60]]);
        $this->actingAs($this->user);
    }

    public function test_settings_have_safe_defaults_strict_validation_and_are_audited(): void
    {
        $s = $this->getJson('/api/intelligence/settings')->assertOk();
        $this->assertSame([true, false, 'quiet', 90, false], [$s->json('settings.enabled'), $s->json('settings.personalization'), $s->json('settings.frequency'), $s->json('settings.retention_days'), $s->json('settings.features.ai_narrative')]);
        $this->assertSame(['allowed' => true, 'connected_data' => false, 'voice' => true, 'provider' => null, 'in_use' => false], $s->json('external_ai'));

        $this->putJson('/api/intelligence/settings', ['frequency' => 'hourly'])->assertUnprocessable();
        $this->putJson('/api/intelligence/settings', ['sources' => ['email' => true]])->assertUnprocessable();
        $this->putJson('/api/intelligence/settings', ['features' => ['autopilot' => true]])->assertUnprocessable();
        $this->putJson('/api/intelligence/settings', ['retention_days' => 365])->assertUnprocessable();
        $this->putJson('/api/intelligence/settings', ['planning_strategy' => 'chaos'])->assertUnprocessable();

        $this->putJson('/api/intelligence/settings', ['personalization' => true, 'sources' => ['focus' => false], 'planning_strategy' => 'deadlines', 'retention_days' => 30])->assertOk()
            ->assertJsonPath('settings.personalization', true)->assertJsonPath('settings.sources.focus', false)->assertJsonPath('settings.sources.calendar', true);
        $this->assertSame('UTC', $this->user->fresh()->preferences()['timezone'], 'other preferences are untouched');
        $this->assertEqualsCanonicalizing(['personalization', 'sources', 'planning_strategy', 'retention_days'], AuditLog::where('action', 'ai_settings_changed')->sole()->meta['changed']);
    }

    public function test_activity_history_and_deleting_ai_data_are_scoped_to_the_user(): void
    {
        $mine = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'schedule', 'provider' => 'local', 'status' => 'applied', 'summary' => 'Plan', 'explanation' => [], 'actions' => [['id' => 'a1']], 'expires_at' => now(), 'applied_at' => now()]);
        $other = User::factory()->create();
        AssistantProposal::create(['user_id' => $other->id, 'kind' => 'schedule', 'provider' => 'local', 'status' => 'pending', 'summary' => 'Theirs', 'explanation' => [], 'actions' => [], 'expires_at' => now()->addHour()]);
        Recommendation::create(['user_id' => $this->user->id, 'key' => 'k', 'type' => 'focus', 'severity' => 'low', 'status' => 'dismissed', 'payload' => ['title' => ['en' => 'x', 'ar' => 'x']], 'first_seen_at' => now(), 'last_seen_at' => now()]);
        Recommendation::create(['user_id' => $other->id, 'key' => 'k', 'type' => 'focus', 'severity' => 'low', 'status' => 'active', 'payload' => ['title' => ['en' => 'y', 'ar' => 'y']], 'first_seen_at' => now(), 'last_seen_at' => now()]);
        AuditLog::create(['user_id' => $this->user->id, 'action' => 'ai_action_executed', 'meta' => ['kind' => 'schedule', 'actions' => 1, 'ip' => 'secret']]);
        $task = Task::factory()->create(['user_id' => $this->user->id]);

        $a = $this->getJson('/api/intelligence/activity')->assertOk();
        $this->assertSame([$mine->id], collect($a->json('proposals'))->pluck('id')->all());
        $this->assertCount(1, $a->json('recommendations'));
        $this->assertSame(['kind' => 'schedule', 'actions' => 1], $a->json('events.0.meta'), 'only safe fields are shown');

        $this->deleteJson('/api/intelligence/data')->assertOk()->assertJsonPath('deleted', ['recommendations' => 1, 'proposals' => 1, 'conversations' => 0, 'plan_learning' => 0]);
        $this->assertSame(1, AssistantProposal::count());
        $this->assertSame(1, Recommendation::count());
        $this->assertTrue($task->fresh()->exists, 'work data is never deleted');
        $this->assertSame(1, AuditLog::where('action', 'ai_data_deleted')->count());
    }

    private function week(): void
    {
        $at = fn (string $local) => CarbonImmutable::parse($local, 'UTC');
        // Last week (15–21 March): 3 completed tasks, 2 late and 2 over estimate; focus fell from 300 to 100 minutes.
        foreach ([['A', '2027-03-16 10:00', '2027-03-15 17:00', 60, 120], ['B', '2027-03-17 10:00', '2027-03-18 17:00', 30, 30], ['C', '2027-03-19 18:00', '2027-03-19 12:00', 60, 100]] as [$title, $done, $due, $est, $actual]) {
            Task::factory()->create(['user_id' => $this->user->id, 'title' => "Secret {$title}", 'status' => 'completed', 'completed_at' => $at($done), 'due_at' => $at($due), 'estimated_minutes' => $est, 'actual_minutes' => $actual]);
        }
        foreach ([['2027-03-09 09:00', 300], ['2027-03-16 09:00', 100]] as [$start, $minutes]) {
            FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => $minutes * 60, 'elapsed_seconds' => $minutes * 60, 'started_at' => $at($start), 'completed_at' => $at($start)->addMinutes($minutes)]);
        }
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Offsite', 'kind' => 'fixed', 'starts_at' => $at('2027-03-18 09:00'), 'ends_at' => $at('2027-03-18 17:00')]);
    }

    public function test_weekly_intelligence_separates_facts_from_interpretations(): void
    {
        $this->week();
        $w = $this->getJson('/api/reviews/2027-03-15')->assertOk()->json('intelligence');
        $facts = collect($w['facts'])->keyBy('key');
        $this->assertSame([3, 100, 300, -67, 33, 2], [$facts['completed']['value'], $facts['focus_minutes']['value'], $facts['focus_minutes']['previous'], $facts['focus_minutes']['change_percent'], $facts['on_time_rate']['value'], $facts['estimate_overruns']['value']]);
        $keys = collect($w['interpretations'])->pluck('key')->all();
        $this->assertEqualsCanonicalizing(['focus_trend', 'busy_day_focus', 'deadlines_slipped', 'estimates'], $keys);
        foreach ($w['interpretations'] as $i) {
            $this->assertSame('rule', $i['kind']);
            $this->assertNotEmpty($i['evidence']);
            $this->assertNotEmpty($i['ar']);
        }
        $this->assertSame(480, collect($w['workload'])->firstWhere('date', '2027-03-18')['committed_minutes']);
        $this->assertContains('buffer', collect($w['suggestions'])->pluck('key')->all());
        $this->assertFalse($w['narrative_available']);

        $this->putJson('/api/intelligence/settings', ['features' => ['weekly' => false]])->assertOk();
        $this->assertSame(['enabled' => false], $this->getJson('/api/reviews/2027-03-15')->json('intelligence'));
    }

    public function test_ai_narrative_needs_consent_sends_only_numbers_and_falls_back_on_failure(): void
    {
        $this->week();
        $sent = null;
        $fail = true;
        Http::fake(['api.anthropic.com/*' => function (HttpRequest $r) use (&$sent, &$fail) {
            $sent = $r['messages'][0]['content'];

            return $fail ? Http::response(['error' => ['type' => 'overloaded_error']], 529)
                : Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => json_encode(['summary' => 'A lighter week for focus, with three tasks done.'])]]]);
        }]);
        $this->postJson('/api/reviews/2027-03-15/narrative')->assertOk()->assertJsonPath('kind', 'rules')->assertJsonPath('fallback_reason', 'disabled')
            ->assertJsonPath('text', fn ($t) => str_contains($t, 'You completed 3 task(s)'));

        $this->putJson('/api/intelligence/settings', ['features' => ['ai_narrative' => true]])->assertOk();
        $this->postJson('/api/reviews/2027-03-15/narrative')->assertOk()->assertJsonPath('fallback_reason', 'not_available');
        Http::assertNothingSent();

        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        $this->postJson('/api/reviews/2027-03-15/narrative')->assertOk()->assertJsonPath('kind', 'rules')->assertJsonPath('fallback_reason', 'provider_error');
        $fail = false;
        $this->postJson('/api/reviews/2027-03-15/narrative')->assertOk()->assertJsonPath('kind', 'ai')->assertJsonPath('text', 'A lighter week for focus, with three tasks done.');
        $this->assertStringNotContainsString('Secret', (string) $sent, 'only numbers are sent, never task titles');
        $this->assertStringContainsString('"focus_minutes"', (string) $sent);

        $calls = count(Http::recorded());
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->fresh()->preferences(), ['assistant_external' => false])]);
        $this->postJson('/api/reviews/2027-03-15/narrative')->assertOk()->assertJsonPath('fallback_reason', 'not_available');
        $this->assertCount($calls, Http::recorded(), 'no request once external AI is turned off');
    }

    public function test_planner_offers_deadline_first_handles_interruptions_and_never_writes_without_approval(): void
    {
        $at = fn (string $local) => CarbonImmutable::parse("2027-03-22 {$local}", 'UTC');
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Later, important', 'priority' => 'urgent', 'estimated_minutes' => 60, 'due_at' => $at('17:00')->addDays(3)]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Due today', 'priority' => 'low', 'estimated_minutes' => 60, 'due_at' => $at('16:00')]);
        $plan = $this->getJson('/api/day-plan?date=2027-03-22')->assertOk()->json();
        $deadlines = collect($plan['alternatives'])->firstWhere('key', 'deadlines');
        $this->assertSame('Deadlines first', $deadlines['title']['en']);
        $this->assertSame('Due today', collect($deadlines['items'])->sortBy('starts_at')->first()['title'], 'nearest deadline gets the first slot');

        $interrupted = $this->getJson('/api/day-plan?date=2027-03-22&replan=1&busy_until=13:00&lost_minutes=30')->assertOk()->json();
        $this->assertSame(['busy_until' => '13:00', 'lost_minutes' => 30], $interrupted['interruption']);
        $this->assertSame('deadlines', $interrupted['recommended'], 're-planning with deadlines near suggests deadline-first');
        $this->assertTrue(collect($interrupted['alternatives'])->flatMap(fn ($a) => $a['items'])->every(fn ($i) => $i['starts_at'] >= '2027-03-22T13:00'));
        $this->assertSame($plan['budget']['capacity_minutes'] - 240 - 30, $interrupted['budget']['capacity_minutes']);
        $this->assertStringContainsString('busy until then', collect($interrupted['explanation'])->pluck('en')->implode(' '));
        $this->getJson('/api/day-plan?date=2027-03-22&lost_minutes=9999')->assertUnprocessable();
        $this->getJson('/api/day-plan?date=2027-03-22&busy_until=25:00')->assertUnprocessable();

        $this->putJson('/api/intelligence/settings', ['planning_strategy' => 'light'])->assertOk();
        $this->assertSame('light', $this->getJson('/api/day-plan?date=2027-03-22')->json('recommended'));

        $events = CalendarEvent::count();
        $proposal = $this->postJson('/api/day-plan', ['date' => '2027-03-22', 'variant' => 'deadlines', 'busy_until' => '13:00'])->assertCreated()->assertJsonPath('status', 'pending')->json();
        $this->assertTrue(collect($proposal['items'])->every(fn ($i) => $i['starts_at'] >= '2027-03-22T13:00'));
        $this->assertSame($events, CalendarEvent::count(), 'a chosen plan is only a proposal until accepted');
    }
}
