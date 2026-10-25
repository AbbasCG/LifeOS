<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\Goal;
use App\Models\InboxNotification;
use App\Models\Recommendation;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\IntelligenceService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ProactiveCopilotTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Tuesday 23 March 2027, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2027-03-23 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        $this->actingAs($this->user);
    }

    private function at(string $local): CarbonImmutable
    {
        return CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
    }

    private function recommendations(): Collection
    {
        app(IntelligenceService::class)->forget($this->user);

        return collect($this->getJson('/api/recommendations')->assertOk()->json('data'));
    }

    private function situations(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Board deck', 'priority' => 'high', 'estimated_minutes' => 90, 'due_at' => $this->at('2027-03-23 18:00')]);
        $postponed = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Dentist forms', 'priority' => 'low', 'estimated_minutes' => 20, 'due_at' => $this->at('2027-03-20 12:00')]);
        foreach (['2027-03-25 12:00', '2027-03-28 12:00', '2027-04-02 12:00'] as $due) {
            $postponed->update(['due_at' => $this->at($due)]);
        }
        $block = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Write report']);
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $block->id, 'title' => 'Write report', 'kind' => 'flexible', 'starts_at' => $this->at('2027-03-24 10:30'), 'ends_at' => $this->at('2027-03-24 11:30')]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Client call', 'kind' => 'fixed', 'starts_at' => $this->at('2027-03-24 10:00'), 'ends_at' => $this->at('2027-03-24 11:00')]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Offsite', 'kind' => 'fixed', 'starts_at' => $this->at('2027-03-25 08:00'), 'ends_at' => $this->at('2027-03-25 18:00')]);
        Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Learn Spanish', 'progress' => 5, 'target' => 100, 'created_at' => now()->subDays(60), 'due_at' => now()->addDays(6)]);
    }

    public function test_each_situation_becomes_one_explained_recommendation_and_stays_deduplicated(): void
    {
        $this->situations();
        $recs = $this->recommendations();
        $this->assertEqualsCanonicalizing(['deadline', 'postponed', 'conflict', 'overload', 'goal', 'focus'], $recs->pluck('type')->all());
        $deadline = $recs->firstWhere('type', 'deadline');
        $this->assertSame(['high', 'Find time', 'proposal'], [$deadline['severity'], $deadline['action']['label']['en'], $deadline['action']['kind']]);
        $this->assertStringContainsString('Board deck', $deadline['title']['en']);
        $this->assertNotEmpty($deadline['title']['ar']);
        $this->assertSame('/timeline?date=2027-03-24', $recs->firstWhere('type', 'conflict')['action']['to']);
        $this->assertStringContainsString('3 times', $recs->firstWhere('type', 'postponed')['title']['en']);
        foreach ($recs as $r) {
            $this->assertContains($r['confidence'], ['high', 'medium', 'low']);
            $this->assertNotEmpty($r['sources']);
        }
        $this->assertSame('high', $recs->first()['severity'], 'most important first');

        $this->recommendations();
        $this->recommendations();
        $this->assertSame(6, Recommendation::count(), 'refreshing never duplicates a situation');
        $this->assertSame(0, InboxNotification::count(), 'quiet by default: no notifications');
    }

    public function test_dismissed_snoozed_and_resolved_recommendations_behave_honestly(): void
    {
        $this->situations();
        $recs = $this->recommendations();
        $goal = $recs->firstWhere('type', 'goal');
        $focus = $recs->firstWhere('type', 'focus');
        $this->postJson("/api/recommendations/{$goal['id']}/dismiss")->assertOk()->assertJsonPath('status', 'dismissed');
        $this->postJson("/api/recommendations/{$focus['id']}/dismiss", ['snooze_days' => 1])->assertOk()->assertJsonPath('status', 'snoozed');
        $this->postJson("/api/recommendations/{$focus['id']}/dismiss", ['snooze_days' => 2])->assertUnprocessable();
        $this->assertNotContains('goal', $this->recommendations()->pluck('type')->all(), 'a dismissed situation is not shown again');
        $this->assertNotContains('focus', $this->recommendations()->pluck('type')->all());

        // The deadline is handled: time is blocked for it, so the recommendation resolves itself.
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => Task::where('title', 'Board deck')->value('id'), 'title' => 'Board deck', 'kind' => 'flexible', 'starts_at' => $this->at('2027-03-23 13:00'), 'ends_at' => $this->at('2027-03-23 14:30')]);
        $this->assertNotContains('deadline', $this->recommendations()->pluck('type')->all());
        $this->assertSame('resolved', Recommendation::where('type', 'deadline')->value('status'));
        $this->assertSame(1, AuditLog::where('action', 'recommendation_dismissed')->where('meta->snooze_days', 1)->count());
    }

    public function test_acting_creates_a_proposal_that_still_needs_approval_and_can_be_undone(): void
    {
        $this->situations();
        $deadline = $this->recommendations()->firstWhere('type', 'deadline');
        $events = CalendarEvent::count();

        $proposal = $this->postJson("/api/recommendations/{$deadline['id']}/act")->assertCreated()->assertJsonPath('status', 'pending')->assertJsonPath('kind', 'find_time')->json();
        $this->assertSame($events, CalendarEvent::count(), 'nothing changes until the proposal is approved');
        $this->assertSame(['acted', $proposal['id']], [Recommendation::find($deadline['id'])->status, Recommendation::find($deadline['id'])->proposal_id]);
        $this->postJson("/api/recommendations/{$deadline['id']}/act")->assertUnprocessable();

        $this->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertSame($events + 1, CalendarEvent::count());
        $this->postJson("/api/assistant/proposals/{$proposal['id']}/undo")->assertOk()->assertJsonPath('status', 'undone');
        $this->assertSame($events, CalendarEvent::count());

        $conflict = Recommendation::where('type', 'conflict')->first();
        $this->postJson("/api/recommendations/{$conflict->id}/act")->assertUnprocessable(); // links only navigate
        $overload = Recommendation::where('type', 'overload')->first();
        $this->postJson("/api/recommendations/{$overload->id}/act")->assertJsonPath('kind', fn ($k) => $k === null || $k === 'rebalance');
    }

    public function test_feedback_quiets_a_type_only_with_opt_in_personalization(): void
    {
        $this->situations();
        foreach (range(1, 3) as $i) {
            Recommendation::create(['user_id' => $this->user->id, 'key' => "old-focus-{$i}", 'type' => 'focus', 'severity' => 'low', 'status' => 'resolved', 'payload' => ['title' => ['en' => 'x', 'ar' => 'x']], 'feedback' => 'not_useful', 'first_seen_at' => now(), 'last_seen_at' => now()]);
        }
        $this->assertContains('focus', $this->recommendations()->pluck('type')->all(), 'without personalization, feedback changes nothing');

        $this->putJson('/api/intelligence/settings', ['personalization' => true])->assertOk();
        Recommendation::where('type', 'focus')->where('status', 'active')->delete();
        $this->assertNotContains('focus', $this->recommendations()->pluck('type')->all());
        $this->assertSame(['focus'], $this->getJson('/api/recommendations')->json('quiet_types'));

        $deadline = Recommendation::where('type', 'deadline')->first();
        $this->postJson("/api/recommendations/{$deadline->id}/feedback", ['useful' => true])->assertOk()->assertJsonPath('feedback', 'useful');
        $this->postJson('/api/intelligence/reset-personalization')->assertOk()->assertJsonPath('cleared', 4);
        $this->assertSame([], $this->getJson('/api/recommendations')->json('quiet_types'));
    }

    public function test_recommendations_are_private_and_respect_frequency(): void
    {
        $this->situations();
        $mine = $this->recommendations()->first();
        $other = User::factory()->create();
        $this->actingAs($other);
        $this->getJson('/api/recommendations')->assertOk()->assertJsonCount(0, 'data');
        $this->postJson("/api/recommendations/{$mine['id']}/dismiss")->assertNotFound();
        $this->postJson("/api/recommendations/{$mine['id']}/act")->assertNotFound();
        $this->postJson("/api/recommendations/{$mine['id']}/feedback", ['useful' => false])->assertNotFound();
        $this->actingAs($this->user);

        $this->putJson('/api/intelligence/settings', ['frequency' => 'off'])->assertOk();
        $this->getJson('/api/recommendations')->assertOk()->assertJsonPath('enabled', false)->assertJsonCount(0, 'data');
        $this->getJson('/api/intelligence/briefing')->assertOk()->assertJsonCount(0, 'suggestions');

        $this->putJson('/api/intelligence/settings', ['frequency' => 'daily'])->assertOk();
        $this->recommendations();
        $this->recommendations();
        $this->assertSame(1, InboxNotification::where('user_id', $this->user->id)->count(), 'at most one digest per day');

        // The hourly job prunes history past retention and never touches work data.
        $this->putJson('/api/intelligence/settings', ['frequency' => 'quiet'])->assertOk();
        Recommendation::query()->update(['updated_at' => now()->subDays(100)]);
        $tasks = Task::count();
        Http::fake();
        Artisan::call('lifeos:recommendations');
        $this->assertSame(0, Recommendation::where('user_id', $this->user->id)->count());
        $this->assertSame($tasks, Task::count());
        Http::assertNothingSent();
        $this->assertSame(0, AssistantProposal::count());
    }
}
