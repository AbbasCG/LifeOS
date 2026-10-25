<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarEvent;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\InboxNotification;
use App\Models\PlanTemplate;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\IntelligenceSettings;
use App\Services\PlanLearning;
use App\Services\WeeklyDraftService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * V16: opt-in weekly plan drafts, prepared on the user's schedule as pending Copilot proposals.
 */
class WeeklyDraftTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Sunday 1 November 2026, 17:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-11-01 17:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'estimated_minutes' => 600, 'priority' => 'high', 'status' => 'todo', 'due_at' => null]);
    }

    private function enable(array $extra = []): void
    {
        $this->actingAs($this->user)->putJson('/api/copilot/weekly-draft', ['enabled' => true, 'weekday' => 0, 'time' => '18:00'] + $extra)->assertOk();
    }

    public function test_drafts_are_off_by_default_and_the_schedule_prepares_nothing(): void
    {
        $this->actingAs($this->user)->getJson('/api/copilot/weekly-draft')->assertOk()
            ->assertJsonPath('settings', ['enabled' => false, 'weekday' => 0, 'time' => '18:00', 'template_id' => null, 'last_week' => null])->assertJsonPath('next_week', '2026-11-02');
        $this->travelTo(CarbonImmutable::parse('2026-11-01 19:00', 'Europe/Amsterdam'));
        $this->artisan('lifeos:weekly-drafts')->assertSuccessful();
        $this->assertSame(0, Conversation::count());
    }

    public function test_the_schedule_prepares_one_pending_draft_at_the_chosen_time_and_notifies_once(): void
    {
        $this->enable();
        $this->artisan('lifeos:weekly-drafts')->assertSuccessful();
        $this->assertSame(0, Conversation::count(), 'not before 18:00');

        $this->travelTo(CarbonImmutable::parse('2026-11-01 18:05', 'Europe/Amsterdam'));
        $this->artisan('lifeos:weekly-drafts')->assertSuccessful();
        $this->artisan('lifeos:weekly-drafts')->assertSuccessful();

        $conversation = Conversation::sole();
        $this->assertSame('Draft next week’s plan (2 Nov – 8 Nov)', $conversation->title);
        $reply = ConversationMessage::where('conversation_id', $conversation->id)->where('role', 'assistant')->sole();
        $this->assertSame('plan_week', $reply->intent);
        $this->assertStringContainsString('Draft prepared on your schedule, with the week planner and your preferences. Nothing changes until you approve it.', $reply->payload['notice']);
        $proposal = AssistantProposal::where('conversation_id', $conversation->id)->sole();
        $this->assertSame('pending', $proposal->status);
        $this->assertSame('2026-11-02 23:59', $proposal->expires_at->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'), 'open until the end of Monday');
        $this->assertGreaterThan(0, collect($proposal->actions)->where('type', 'create_event')->count());
        $this->assertTrue(collect($proposal->actions)->every(fn ($a) => ($a['starts_at'] ?? '2026-11-02') >= '2026-11-01T23'), 'only next week is planned');
        $this->assertSame(0, CalendarEvent::count(), 'nothing is written');

        $notification = InboxNotification::where('kind', 'weekly_draft')->sole();
        $this->assertSame('planning', $notification->category);
        $this->assertSame('Next week’s plan draft is ready', $notification->title);
        $this->assertSame("/assistant?c={$conversation->id}", $notification->link);
        $this->assertSame('2026-11-02', WeeklyDraftService::settings($this->user)['last_week']);
        $this->assertSame(['week' => '2026-11-02', 'scheduled' => true, 'source' => 'planner', 'proposal' => true], AuditLog::where('action', 'weekly_draft_prepared')->sole()->meta);

        // The next Sunday prepares the next week.
        $this->travelTo(CarbonImmutable::parse('2026-11-08 18:30', 'Europe/Amsterdam'));
        $this->artisan('lifeos:weekly-drafts')->assertSuccessful();
        $this->assertSame(2, Conversation::count());
    }

    public function test_a_draft_uses_the_chosen_template_and_falls_back_when_it_is_gone(): void
    {
        $template = PlanTemplate::create(['user_id' => $this->user->id, 'name' => 'Deep week', 'blocks' => [
            ['weekday' => 1, 'start' => '09:00', 'minutes' => 90, 'title' => 'Focus: Thesis', 'task_id' => null],
            ['weekday' => 3, 'start' => '10:00', 'minutes' => 60, 'title' => 'Writing', 'task_id' => null],
        ]]);
        $this->enable(['template_id' => $template->id]);

        $r = $this->postJson('/api/copilot/weekly-draft', ['language' => 'en'])->assertCreated()
            ->assertJsonPath('message.intent', 'use_template')->assertJsonPath('message.proposal.kind', 'template')->assertJsonPath('message.proposal.status', 'pending');
        $this->assertStringContainsString('Draft prepared at your request, from your template “Deep week”.', $r->json('message.notice'));
        $this->assertSame(['2026-11-02T08:00:00+00:00', '2026-11-04T09:00:00+00:00'], collect($r->json('message.proposal.actions'))->pluck('starts_at')->all());
        $this->assertSame(0, InboxNotification::count(), 'a draft asked for now is not notified');
        $this->assertNull(WeeklyDraftService::settings($this->user)['last_week'], 'and does not replace the scheduled one');

        $template->delete();
        $this->postJson('/api/copilot/weekly-draft', ['language' => 'ar'])->assertCreated()->assertJsonPath('message.intent', 'plan_week')
            ->assertJsonPath('conversation.language', 'ar')->assertJsonPath('message.notice', fn (string $n) => str_contains($n, 'لأن القالب المختار لم يعد موجوداً'));
    }

    public function test_drafts_use_learned_preferences(): void
    {
        IntelligenceSettings::save($this->user, ['features' => ['plan_learning' => true]]);
        foreach (range(1, 3) as $i) {
            PlanLearning::record($this->user, 'week_version', 'essentials');
        }
        $this->enable();
        $this->postJson('/api/copilot/weekly-draft', ['language' => 'en'])->assertCreated()
            ->assertJsonPath('message.state.slots.alternative', 'essentials')->assertJsonPath('message.plan.learned.week_version', 'essentials')
            ->assertJsonPath('message.state.slots.next_week', true);
    }

    public function test_drafts_respect_the_ai_switch_and_settings_are_validated_and_private(): void
    {
        $this->enable(['weekday' => 0, 'time' => '17:30']);
        IntelligenceSettings::save($this->user, ['enabled' => false]);
        $this->travelTo(CarbonImmutable::parse('2026-11-01 18:00', 'Europe/Amsterdam'));
        $this->artisan('lifeos:weekly-drafts')->assertSuccessful();
        $this->assertSame(0, Conversation::count(), 'AI features off: no drafts');

        $other = User::factory()->create();
        $theirs = PlanTemplate::create(['user_id' => $other->id, 'name' => 'Theirs', 'blocks' => [['weekday' => 1, 'start' => '09:00', 'minutes' => 60, 'title' => 'X', 'task_id' => null]]]);
        $this->putJson('/api/copilot/weekly-draft', ['template_id' => $theirs->id])->assertUnprocessable();
        $this->putJson('/api/copilot/weekly-draft', ['weekday' => 7])->assertUnprocessable();
        $this->putJson('/api/copilot/weekly-draft', ['time' => '18:10'])->assertUnprocessable();
        $this->putJson('/api/copilot/weekly-draft', ['time' => '7:00'])->assertUnprocessable();
        $this->postJson('/api/copilot/weekly-draft', ['language' => 'fr'])->assertUnprocessable();
        $this->putJson('/api/copilot/weekly-draft', ['weekday' => 5, 'time' => '16:45'])->assertOk()->assertJsonPath('settings.weekday', 5)->assertJsonPath('settings.time', '16:45');
        $this->assertSame(['weekday' => 5, 'time' => '16:45'], AuditLog::where('action', 'weekly_draft_settings_changed')->latest('id')->first()->meta);
        $this->getJson('/api/intelligence/activity')->assertOk()->assertJsonPath('events.0.action', 'weekly_draft_settings_changed');

        $this->app['auth']->forgetGuards();
        $this->getJson('/api/copilot/weekly-draft')->assertUnauthorized();
    }
}
