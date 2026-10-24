<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\ExternalEvent;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class ConnectedPlanningTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private CalendarAccount $google;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Tuesday 23 March 2027, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2027-03-23 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'study_start' => '19:00', 'study_end' => '21:00']]);
        $this->google = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@gmail.com', 'access_token' => 'x', 'status' => 'active']);
    }

    private function at(string $local): CarbonImmutable
    {
        return CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
    }

    private function ask(string $message, string $language = 'en'): TestResponse
    {
        return $this->actingAs($this->user)->postJson('/api/assistant', ['message' => $message, 'language' => $language])->assertOk();
    }

    private function meeting(string $title, string $start, string $end): ExternalEvent
    {
        return ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->google->id, 'calendar_id' => 'primary', 'external_id' => $title, 'title' => $title, 'starts_at' => $this->at($start), 'ends_at' => $this->at($end)]);
    }

    public function test_find_time_for_study_tasks_works_around_connected_calendars_and_needs_approval(): void
    {
        Http::fake();
        $study = Category::factory()->create(['user_id' => $this->user->id, 'area' => 'study']);
        $exam = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Revise statistics', 'category_id' => $study->id, 'estimated_minutes' => 60, 'priority' => 'high', 'due_at' => $this->at('2027-03-26 23:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Work report', 'estimated_minutes' => 60, 'due_at' => $this->at('2027-03-26 23:00')]);
        $this->meeting('Evening class', '2027-03-23 19:00', '2027-03-23 20:15');

        $proposal = $this->ask('Find time for my study tasks')->assertJsonPath('intent', 'find_time')->assertJsonPath('proposal.kind', 'find_time')->json('proposal');
        $this->assertSame(['Revise statistics'], array_column($proposal['actions'], 'title'), 'only study-area tasks');
        $block = $proposal['actions'][0];
        $start = CarbonImmutable::parse($block['starts_at'])->setTimezone('Europe/Amsterdam');
        $this->assertSame('2027-03-23 20:25', $start->format('Y-m-d H:i'), 'inside the study window, after the Google event and a break');
        $this->assertStringContainsString('1 Google from connected calendars', implode(' ', $proposal['explanation']));
        $this->assertSame(0, CalendarEvent::count(), 'nothing is created before approval');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertSame($exam->id, CalendarEvent::sole()->task_id);
        $this->assertSame(1, ExternalEvent::count());
        Http::assertNothingSent();

        $this->ask('اعثر على وقت لمهام الدراسة', 'ar')->assertJsonPath('intent', 'find_time');
    }

    public function test_plan_my_day_around_connected_calendars_is_a_suggestion_only(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Draft proposal', 'estimated_minutes' => 90, 'priority' => 'high', 'due_at' => $this->at('2027-03-24 17:00')]);
        $this->meeting('Client call', '2027-03-23 10:00', '2027-03-23 11:00');
        $this->meeting('Board sync', '2027-03-24 09:00', '2027-03-24 12:00');

        $today = $this->ask('Plan my day around my Google Calendar')->assertJsonPath('intent', 'plan_day');
        $this->assertStringContainsString('including 1 Google from connected calendars', $today->json('message'));
        $this->assertStringContainsString('/today/plan?date=2027-03-23&variant=', collect($today->json('items'))->last()['link']);
        $blocks = collect($today->json('items'))->where('type', 'plan_block');
        $this->assertNotEmpty($blocks);
        $this->assertFalse($blocks->contains(fn ($b) => str_starts_with($b['detail'], '10:')), 'no block during the Google meeting');

        $tomorrow = $this->ask('Suggest a better schedule for tomorrow')->assertJsonPath('intent', 'plan_day');
        $this->assertStringContainsString('date=2027-03-24', collect($tomorrow->json('items'))->last()['link']);
        $this->assertSame(0, ScheduleProposal::count());
        $this->assertSame(0, CalendarEvent::count());
        $this->ask('خطط يومي حول اجتماعاتي', 'ar')->assertJsonPath('intent', 'plan_day');
    }

    public function test_deadline_conflicts_name_connected_meetings(): void
    {
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Tender submission', 'estimated_minutes' => 480, 'due_at' => $this->at('2027-03-24 12:00')]);
        $this->meeting('Workshop', '2027-03-23 09:00', '2027-03-23 16:30');

        $r = $this->ask('Which deadlines conflict with my meetings?')->assertJsonPath('intent', 'deadline_conflicts');
        $this->assertStringContainsString('1 deadline(s) may not fit around your meetings', $r->json('message'));
        $this->assertStringContainsString('1 from connected calendars', $r->json('items.0.detail'));
        $this->assertSame([], collect($r->json('items'))->where('type', 'overlap')->all(), 'only deadlines are listed');
        $this->ask('أي المواعيد النهائية تتعارض مع اجتماعاتي؟', 'ar')->assertJsonPath('intent', 'deadline_conflicts');
    }

    public function test_external_ai_plans_with_connected_time_but_not_connected_details_without_consent(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        $study = Category::factory()->create(['user_id' => $this->user->id, 'area' => 'study']);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Flashcards', 'category_id' => $study->id, 'estimated_minutes' => 30, 'due_at' => $this->at('2027-03-27 20:00')]);
        $this->meeting('Therapy session', '2027-03-23 19:00', '2027-03-23 20:00');
        $input = null;
        Http::fake(['api.anthropic.com/*' => function (HttpRequest $r) use (&$input) {
            $input = $r['messages'][0]['content'];

            return Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => json_encode(['message' => 'Sure.', 'intent' => 'find_time', 'schedule' => null, 'query' => null, 'target' => ['task_id' => null, 'goal_id' => null, 'area' => 'study', 'date' => null], 'subtasks' => []])]]]);
        }]);

        $r = $this->ask('Could you carve out some time for studying?')->assertJsonPath('provider', 'anthropic')->assertJsonPath('proposal.kind', 'find_time');
        $this->assertSame('2027-03-23 20:10', CarbonImmutable::parse($r->json('proposal.actions.0.starts_at'))->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));
        $this->assertStringNotContainsString('Therapy session', $input);
        $this->assertStringContainsString('Busy', $input);
        $this->assertSame(1, AssistantProposal::where('status', 'pending')->count());
    }
}
