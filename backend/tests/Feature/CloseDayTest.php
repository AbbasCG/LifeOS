<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\ExternalEvent;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * "Close the day": POST /api/today/close (recap + a 'close_day' proposal of existing action types) and the close_day hint of GET /api/today.
 * The clock is pinned to Wednesday 2026-11-18 18:00 UTC (UTC account, work 09:00-17:00 Monday to Friday, 10-minute breaks), after work.
 */
class CloseDayTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2026-11-18 18:00', 'UTC'));
        $this->user = $this->makeUser();
    }

    /** @param array<string, mixed> $prefs */
    private function makeUser(array $prefs = []): User
    {
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => $prefs + ['timezone' => 'UTC', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);

        return $user;
    }

    private function at(string $hm, string $date = '2026-11-18'): CarbonImmutable
    {
        return CarbonImmutable::parse("{$date} {$hm}", 'UTC');
    }

    /** @param array<string, mixed> $extra */
    private function task(string $title, ?CarbonImmutable $due = null, string $priority = 'medium', array $extra = [], ?User $user = null): Task
    {
        return Task::create(array_replace(['user_id' => ($user ?? $this->user)->id, 'title' => $title, 'estimated_minutes' => 60, 'priority' => $priority, 'due_at' => $due, 'status' => 'todo'], $extra));
    }

    private function dateOnly(string $title, string $date = '2026-11-18', string $priority = 'medium'): Task
    {
        return $this->task($title, Task::endOfDay($date, 'UTC'), $priority, ['due_all_day' => true]);
    }

    private function block(Task $task, string $from, string $to, string $date = '2026-11-18', string $kind = 'flexible'): CalendarEvent
    {
        return CalendarEvent::create(['user_id' => $task->user_id, 'task_id' => $task->id, 'title' => $task->title, 'starts_at' => $this->at($from, $date), 'ends_at' => $this->at($to, $date), 'kind' => $kind]);
    }

    private function busy(string $from, string $to, string $date = '2026-11-19', ?User $user = null): CalendarEvent
    {
        return CalendarEvent::create(['user_id' => ($user ?? $this->user)->id, 'title' => 'Busy', 'starts_at' => $this->at($from, $date), 'ends_at' => $this->at($to, $date), 'kind' => 'fixed']);
    }

    private function focus(?Task $task, int $minutes, string $kind = 'focus', ?CarbonImmutable $at = null): FocusSession
    {
        return FocusSession::create(['user_id' => $this->user->id, 'task_id' => $task?->id, 'kind' => $kind, 'status' => 'completed', 'duration_seconds' => $minutes * 60, 'elapsed_seconds' => $minutes * 60, 'completed_at' => $at ?? $this->at('12:00')]);
    }

    private function close(?User $user = null): TestResponse
    {
        return $this->actingAs($user ?? $this->user)->postJson('/api/today/close');
    }

    private function local(string|CarbonImmutable $at): string
    {
        return CarbonImmutable::parse($at)->utc()->format('Y-m-d H:i');
    }

    /** A day with each kind of open work and things that must be left alone. @return array<string, Task> */
    private function day(): array
    {
        $open = $this->task('Open session', $this->at('17:00', '2026-11-25'), 'urgent');
        $this->block($open, '18:30', '19:30');
        $missed = $this->task('Missed one', $this->at('17:00', '2026-11-25'), 'high');
        $this->block($missed, '14:00', '15:00');
        $dateOnly = $this->dateOnly('Date-only due', '2026-11-18', 'low');
        $timed = $this->task('Timed due', $this->at('16:00'), 'low');
        $done = $this->task('Done today', $this->at('17:00'), 'high', ['status' => 'completed', 'completed_at' => $this->at('15:30')]);
        $this->block($done, '10:00', '11:00');
        $focused = $this->task('Worked on', $this->at('17:00', '2026-11-25'));
        $this->block($focused, '09:00', '10:00');
        $this->focus($focused, 25);
        $rebooked = $this->task('Already rebooked', $this->at('17:00', '2026-11-25'));
        $this->block($rebooked, '12:00', '13:00');
        $this->block($rebooked, '15:00', '16:00', '2026-11-19');

        return compact('open', 'missed', 'dateOnly', 'timed', 'done', 'focused', 'rebooked');
    }

    public function test_the_recap_counts_the_local_day_so_far(): void
    {
        $this->day();
        $this->task('Finished report', null, 'medium', ['status' => 'completed', 'completed_at' => $this->at('16:45')]);
        $this->task('Yesterday', null, 'medium', ['status' => 'completed', 'completed_at' => $this->at('16:00', '2026-11-17')]);
        $this->focus(null, 30, 'manual');
        $this->focus(null, 5, 'break');
        $this->focus(null, 50, 'focus', $this->at('20:00', '2026-11-17'));

        $recap = $this->close()->assertOk()->json('recap');

        $this->assertSame(['completed' => 2, 'focus_minutes' => 55, 'planned_minutes' => 300, 'done_titles' => ['Finished report', 'Done today']], $recap,
            'two done today (latest first), 25 + 30 focus minutes (breaks and yesterday not counted), five one-hour task sessions today');
    }

    public function test_open_work_gets_the_right_actions_and_done_work_none(): void
    {
        $t = $this->day();

        $response = $this->close()->assertOk()->assertJsonPath('proposal.kind', 'close_day')->assertJsonPath('proposal.status', 'pending');
        $actions = collect($response->json('proposal.actions'));

        $this->assertEqualsCanonicalizing([$t['open']->id, $t['missed']->id, $t['dateOnly']->id, $t['timed']->id], $actions->pluck('task_id')->unique()->all());
        $move = $actions->firstWhere('task_id', $t['open']->id);
        $this->assertSame(['move_event', 'session'], [$move['type'], $move['source']]);
        $this->assertSame(CalendarEvent::where('task_id', $t['open']->id)->value('id'), $move['event_id']);
        $this->assertSame('2026-11-18 18:30', $this->local($move['from_starts_at']));
        $this->assertSame('2026-11-19 09:00', $this->local($move['starts_at']), 'the most urgent first, at the start of the next work day');
        $this->assertSame(60, $move['minutes']);
        $create = $actions->firstWhere('task_id', $t['missed']->id);
        $this->assertSame(['create_event', 'session', 60], [$create['type'], $create['source'], $create['minutes']]);
        $this->assertSame('2026-11-19 10:10', $this->local($create['starts_at']), 'after the moved session and a break: one preview never books a slot twice');
        $this->assertStringContainsString('missed', $create['reason']);
        $dateOnly = $actions->firstWhere('task_id', $t['dateOnly']->id);
        $this->assertSame(['reschedule_task', 'deadline', true, '2026-11-19'], [$dateOnly['type'], $dateOnly['source'], $dateOnly['due_all_day'], $dateOnly['due_date']]);
        $this->assertSame('2026-11-19 23:59', $this->local($dateOnly['due_at']));
        $timed = $actions->firstWhere('task_id', $t['timed']->id);
        $this->assertSame(['reschedule_task', false], [$timed['type'], $timed['due_all_day']]);
        $this->assertSame('2026-11-19 16:00', $this->local($timed['due_at']), 'a timed deadline keeps its clock time');
        $this->assertStringContainsString('tomorrow', $timed['reason']);
        foreach ($actions as $action) {
            $this->assertNotSame('', $action['reason']);
        }
        $this->assertSame(1, AssistantProposal::count(), 'only the proposal is written');
        $this->assertSame('2026-11-18 18:30', $this->local(CalendarEvent::where('task_id', $t['open']->id)->value('starts_at')));
    }

    public function test_a_session_today_and_a_deadline_today_both_roll_over(): void
    {
        $task = $this->task('Both', $this->at('20:00'), 'high');
        $this->block($task, '19:00', '19:30');

        $actions = collect($this->close()->assertOk()->json('proposal.actions'));

        $this->assertSame(['move_event', 'reschedule_task'], $actions->pluck('type')->all());
        $this->assertSame(['session', 'deadline'], $actions->pluck('source')->all());
        $this->assertSame('2026-11-19 20:00', $this->local($actions[1]['due_at']));
    }

    public function test_apply_all_and_undo_through_the_proposal_endpoints(): void
    {
        $t = $this->day();
        $proposal = $this->close()->assertOk()->json('proposal');
        $ids = collect($proposal['actions'])->pluck('id')->all();
        $session = CalendarEvent::where('task_id', $t['open']->id)->firstOrFail();

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => $ids])->assertOk()->assertJsonPath('status', 'applied');

        $this->assertSame('2026-11-19 09:00', $this->local($session->fresh()->starts_at), 'moved, same row');
        $this->assertSame(1, CalendarEvent::where('task_id', $t['missed']->id)->where('starts_at', '>', now())->count(), 'a new session for the missed one');
        $this->assertSame('2026-11-19', $t['dateOnly']->fresh()->dueDate('UTC'), 'still date-only');
        $this->assertSame('2026-11-19 16:00', $this->local($t['timed']->fresh()->due_at));
        $this->assertSame(1, (int) $t['dateOnly']->fresh()->postponed_count);
        $this->assertSame(1, (int) $t['timed']->fresh()->postponed_count);

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/undo")->assertOk()->assertJsonPath('status', 'undone');

        $this->assertSame('2026-11-18 18:30', $this->local($session->fresh()->starts_at));
        $this->assertSame(0, CalendarEvent::where('task_id', $t['missed']->id)->where('starts_at', '>', now())->count());
        $this->assertSame('2026-11-18', $t['dateOnly']->fresh()->dueDate('UTC'));
        $this->assertTrue($t['dateOnly']->fresh()->due_all_day);
        $this->assertSame('2026-11-18 16:00', $this->local($t['timed']->fresh()->due_at));
        $this->assertSame(0, (int) $t['dateOnly']->fresh()->postponed_count, 'the postponement is taken back with the undo');
        $this->assertNull($t['timed']->fresh()->last_postponed_at);
    }

    public function test_a_slot_taken_before_apply_is_refused_with_the_structured_conflict(): void
    {
        $t = $this->day();
        $proposal = $this->close()->assertOk()->json('proposal');
        $move = collect($proposal['actions'])->firstWhere('task_id', $t['open']->id);
        $this->busy('09:30', '10:00');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => collect($proposal['actions'])->pluck('id')->all()])
            ->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict')->assertJsonValidationErrors('actions');

        $this->assertSame('2026-11-18 18:30', $this->local(CalendarEvent::findOrFail($move['event_id'])->starts_at), 'nothing applied');
        $this->assertSame('2026-11-18', $t['dateOnly']->fresh()->dueDate('UTC'));
        $this->assertSame('pending', AssistantProposal::first()->status);
    }

    public function test_friday_evening_rolls_to_monday_and_busy_time_and_ramadan_hours_count(): void
    {
        $this->user = $this->makeUser(['ramadan_mode' => 'on', 'ramadan_work_start' => '10:00', 'ramadan_work_end' => '15:00']);
        $this->travelTo(CarbonImmutable::parse('2027-02-12 18:00', 'UTC'));
        $task = $this->task('Friday work', $this->at('17:00', '2027-02-20'), 'high');
        $this->block($task, '19:00', '20:00', '2027-02-12');
        $this->dateOnly('Friday deadline', '2027-02-12');
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@example.com', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'primary', 'external_id' => 'x1', 'title' => 'Google call', 'starts_at' => $this->at('10:00', '2027-02-15'), 'ends_at' => $this->at('10:30', '2027-02-15')]);

        $actions = collect($this->close()->assertOk()->json('proposal.actions'))->keyBy('type');

        $this->assertSame('2027-02-15 10:40', $this->local($actions['move_event']['starts_at']), 'Monday, inside the Ramadan hours, after the connected-calendar call and a break');
        $this->assertSame('2027-02-15', $actions['reschedule_task']['due_date']);
    }

    public function test_the_proposal_is_capped_at_twelve_actions(): void
    {
        foreach (range(1, 14) as $i) {
            $this->dateOnly("Due {$i}");
        }

        $response = $this->close()->assertOk();

        $this->assertCount(12, $response->json('proposal.actions'));
        $this->assertStringContainsString('Limit of 12 changes', implode(' ', $response->json('proposal.explanation')));
    }

    public function test_nothing_open_returns_a_null_proposal_with_the_recap(): void
    {
        $this->task('Done', $this->at('17:00'), 'high', ['status' => 'completed', 'completed_at' => $this->at('11:00')]);
        $this->task('Next week', $this->at('17:00', '2026-11-25'));

        $response = $this->close()->assertOk()->assertJsonPath('proposal', null)->assertJsonPath('recap.completed', 1)->assertJsonPath('recap.done_titles', ['Done']);

        $this->assertStringContainsString('Nothing is left open today', $response->json('summary'));
        $this->assertSame(0, AssistantProposal::count());
    }

    public function test_a_newer_preview_replaces_an_open_older_one(): void
    {
        $this->dateOnly('Due');
        $first = $this->close()->assertOk()->json('proposal.id');
        $second = $this->close()->assertOk()->json('proposal.id');

        $this->assertNotSame($first, $second);
        $this->assertSame('dismissed', AssistantProposal::find($first)->status);
    }

    public function test_the_today_hint_follows_work_end_and_work_days(): void
    {
        $this->dateOnly('Due today');
        $this->travelTo(CarbonImmutable::parse('2026-11-18 16:00', 'UTC'));
        $before = $this->actingAs($this->user)->getJson('/api/today')->assertOk()->assertJsonPath('close_day', ['open_today' => 1, 'suggested' => false])->json();
        foreach (['date', 'period', 'briefing', 'energy', 'focus_time', 'timeline', 'deadlines', 'progress', 'windows', 'timezone', 'day_start', 'reorganize'] as $key) {
            $this->assertArrayHasKey($key, $before, 'existing keys are kept');
        }

        $this->travelTo(CarbonImmutable::parse('2026-11-18 17:00', 'UTC'));
        $this->getJson('/api/today')->assertOk()->assertJsonPath('close_day', ['open_today' => 1, 'suggested' => true]);

        $this->travelTo(CarbonImmutable::parse('2026-11-21 18:00', 'UTC'));
        $this->dateOnly('Saturday chore', '2026-11-21');
        $this->getJson('/api/today')->assertOk()->assertJsonPath('close_day', ['open_today' => 1, 'suggested' => false]);
    }

    public function test_the_today_hint_uses_the_ramadan_work_end_and_needs_open_work(): void
    {
        $this->user = $this->makeUser(['ramadan_mode' => 'on', 'ramadan_work_start' => '10:00', 'ramadan_work_end' => '15:00']);
        $this->travelTo(CarbonImmutable::parse('2027-02-10 15:30', 'UTC'));
        $this->actingAs($this->user)->getJson('/api/today')->assertOk()->assertJsonPath('close_day', ['open_today' => 0, 'suggested' => false]);

        $this->dateOnly('Due today', '2027-02-10');
        $this->getJson('/api/today')->assertOk()->assertJsonPath('close_day', ['open_today' => 1, 'suggested' => true]);
    }

    public function test_another_users_data_is_never_used_and_guests_are_refused(): void
    {
        $other = $this->makeUser();
        $this->task('Their secret', $this->at('20:00'), 'urgent', [], $other);
        $this->busy('09:00', '17:00', '2026-11-19', $other);
        $mine = $this->dateOnly('Mine');
        $session = $this->task('My session', $this->at('17:00', '2026-11-30'));
        $this->block($session, '19:00', '20:00');

        $response = $this->close()->assertOk();

        $this->assertEqualsCanonicalizing([$mine->id, $session->id], collect($response->json('proposal.actions'))->pluck('task_id')->all());
        $this->assertSame('2026-11-19 09:00', $this->local(collect($response->json('proposal.actions'))->firstWhere('type', 'move_event')['starts_at']));
        $this->assertStringNotContainsString('secret', $response->getContent());
        $this->assertSame(0, AssistantProposal::where('user_id', $other->id)->count());

        $this->app['auth']->forgetGuards();
        $this->postJson('/api/today/close')->assertUnauthorized();
    }

    public function test_no_provider_is_called_and_nothing_is_sent_out(): void
    {
        Http::fake();
        config(['ai.provider' => 'openai']);
        $this->day();

        $proposal = $this->close()->assertOk()->json('proposal');
        $this->actingAs($this->user)->getJson('/api/today')->assertOk();
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertOk();

        Http::assertNothingSent();
    }

    public function test_arabic_accounts_get_arabic_text(): void
    {
        $this->user = $this->makeUser(['language' => 'ar']);
        $this->dateOnly('تقرير');

        $response = $this->close()->assertOk();

        $this->assertMatchesRegularExpression('/\p{Arabic}/u', $response->json('summary'));
        $this->assertMatchesRegularExpression('/\p{Arabic}/u', $response->json('proposal.actions.0.reason'));
    }
}
