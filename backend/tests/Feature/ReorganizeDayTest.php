<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\DailyCheckin;
use App\Models\ExternalEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\PrayerTimes;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * "Reorganize my day": a deterministic preview made only of existing action types. The clock is pinned to Wednesday 2026-11-18 11:00 UTC
 * (UTC account, work 09:00-17:00, 10-minute breaks), so the first slot a new session can take is 11:15.
 */
class ReorganizeDayTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2026-11-18 11:00', 'UTC'));
        $this->user = $this->makeUser();
    }

    /** @param array<string, mixed> $prefs */
    private function makeUser(array $prefs = []): User
    {
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => $prefs + ['timezone' => 'UTC', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'buffer_minutes' => 10]]);

        return $user;
    }

    /** @param array<string, mixed> $prefs */
    private function setPrefs(array $prefs, ?User $user = null): void
    {
        $user ??= $this->user;
        UserSetting::where('user_id', $user->id)->update(['preferences' => array_replace($user->fresh()->preferences(), $prefs)]);
    }

    private function at(string $hm, string $date = '2026-11-18', string $tz = 'UTC'): CarbonImmutable
    {
        return CarbonImmutable::parse("{$date} {$hm}", $tz)->utc();
    }

    /** @param array<string, mixed> $extra */
    private function task(string $title, int $minutes = 60, string $priority = 'medium', ?CarbonImmutable $due = null, array $extra = [], ?User $user = null): Task
    {
        return Task::create(array_replace(['user_id' => ($user ?? $this->user)->id, 'title' => $title, 'estimated_minutes' => $minutes, 'priority' => $priority, 'due_at' => $due, 'status' => 'todo'], $extra));
    }

    /** @param array<string, mixed> $extra */
    private function block(Task $task, string $from, string $to, string $date = '2026-11-18', array $extra = []): CalendarEvent
    {
        return CalendarEvent::create(['user_id' => $task->user_id, 'task_id' => $task->id, 'title' => $task->title, 'starts_at' => $this->at($from, $date), 'ends_at' => $this->at($to, $date), 'kind' => 'flexible'] + $extra);
    }

    /** @param array<string, mixed> $extra */
    private function event(string $title, string $from, string $to, string $kind = 'fixed', string $date = '2026-11-18', array $extra = [], ?User $user = null): CalendarEvent
    {
        return CalendarEvent::create(['user_id' => ($user ?? $this->user)->id, 'title' => $title, 'starts_at' => $this->at($from, $date), 'ends_at' => $this->at($to, $date), 'kind' => $kind] + $extra);
    }

    private function reorganize(?User $user = null): TestResponse
    {
        return $this->actingAs($user ?? $this->user)->postJson('/api/today/reorganize');
    }

    /** @return list<array<string, mixed>> */
    private function actionsOf(TestResponse $response): array
    {
        return $response->assertOk()->json('proposal.actions') ?? [];
    }

    private function local(string $iso, string $tz = 'UTC'): string
    {
        return CarbonImmutable::parse($iso)->setTimezone($tz)->format('Y-m-d H:i');
    }

    public function test_a_missed_session_gets_a_new_session_after_now_and_the_old_block_stays(): void
    {
        $task = $this->task('Write report', 60, 'medium', $this->at('17:00', '2026-11-20'));
        $old = $this->block($task, '09:00', '10:00');

        $response = $this->reorganize()->assertOk()->assertJsonPath('proposal.kind', 'reorganize')->assertJsonPath('proposal.status', 'pending')->assertJsonCount(1, 'proposal.actions');
        $action = $response->json('proposal.actions.0');

        $this->assertSame('create_event', $action['type']);
        $this->assertSame($task->id, $action['task_id']);
        $this->assertSame(60, $action['minutes'], 'same length as the missed block');
        $this->assertSame('2026-11-18 11:15', $this->local($action['starts_at']), 'next free slot after now + 15 minutes');
        $this->assertSame('missed', $action['source']);
        $this->assertNotSame('', $action['reason']);
        $this->assertNotEmpty($response->json('proposal.explanation'));
        $this->assertStringNotContainsString('prayer', implode(' ', $response->json('proposal.explanation')), 'prayer times are not mentioned while they are off');
        $this->assertSame(1, CalendarEvent::count(), 'only the proposal is written');
        $this->assertSame('2026-11-18 09:00', $old->fresh()->starts_at->format('Y-m-d H:i'), 'the old block is history, untouched');
        $this->assertSame(1, AssistantProposal::count());
    }

    public function test_a_task_already_rescheduled_later_today_gets_nothing(): void
    {
        $task = $this->task('Write report', 60, 'medium', $this->at('17:00', '2026-11-20'));
        $this->block($task, '09:00', '10:00');
        $this->block($task, '14:00', '15:00');

        $this->reorganize()->assertOk()->assertJsonPath('proposal', null)->assertJsonStructure(['summary']);
        $this->assertSame(0, AssistantProposal::count());
    }

    public function test_a_task_due_today_without_a_session_is_placed_today(): void
    {
        $task = $this->task('Send invoice', 45, 'high', $this->at('16:00'));

        $actions = $this->actionsOf($this->reorganize());

        $this->assertCount(1, $actions);
        $this->assertSame($task->id, $actions[0]['task_id']);
        $this->assertSame('due', $actions[0]['source']);
        $this->assertSame('2026-11-18 11:15', $this->local($actions[0]['starts_at']));
        $this->assertSame(45, $actions[0]['minutes']);
    }

    public function test_overdue_tasks_are_placed_in_rank_order_and_a_task_with_a_future_session_is_skipped(): void
    {
        $low = $this->task('Tidy desk', 30, 'low', $this->at('17:00', '2026-11-15'));
        $urgent = $this->task('Pay tax', 30, 'urgent', $this->at('17:00', '2026-11-16'));
        $high = $this->task('Reply to client', 30, 'high', $this->at('17:00', '2026-11-17'));
        $booked = $this->task('Already booked', 30, 'urgent', $this->at('17:00', '2026-11-14'));
        $this->block($booked, '15:00', '15:30');

        $actions = collect($this->actionsOf($this->reorganize()))->sortBy('starts_at')->values();

        $this->assertSame([$urgent->id, $high->id, $low->id], $actions->pluck('task_id')->all(), 'most urgent first, as BriefingService::rank orders them');
        $this->assertNotContains($booked->id, $actions->pluck('task_id')->all());
        $this->assertStringContainsString('Overdue', $actions[0]['reason']);
    }

    public function test_overflow_moves_only_the_lowest_priority_movable_block(): void
    {
        $this->setPrefs(['language' => 'en']);
        $missed = $this->task('Missed deep work', 60, 'high', $this->at('17:00', '2026-11-20'));
        $this->block($missed, '09:00', '10:00');
        $low = $this->task('Low priority errand', 60, 'low', $this->at('17:00', '2026-11-25'));
        $important = $this->task('Important prep', 60, 'urgent', $this->at('17:00', '2026-11-25'));
        $lowSession = $this->block($low, '14:10', '15:10');
        $importantSession = $this->block($important, '15:20', '16:20');
        $started = $this->event('Started flexible block', '10:30', '11:30', 'flexible');
        $fixed = $this->event('Board meeting', '11:40', '14:00', 'fixed');
        $recurring = $this->event('Daily standup', '16:30', '17:00', 'flexible', '2026-11-18', ['recurrence' => ['freq' => 'daily'], 'timezone' => 'UTC']);
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@example.com', 'access_token' => 'x', 'status' => 'active']);
        // Connected-calendar time is busy too, but it is not ours to move: it sits where the only free minutes would be.
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'primary', 'external_id' => 'x1', 'title' => 'External call', 'starts_at' => $this->at('11:00'), 'ends_at' => $this->at('11:10')]);

        $response = $this->reorganize()->assertOk();
        $actions = collect($response->json('proposal.actions'));

        $moves = $actions->where('type', 'move_event');
        $this->assertSame([$lowSession->id], $moves->pluck('event_id')->all(), 'only the lowest-priority movable block moves');
        $this->assertSame('overflow', $moves->first()['source']);
        $this->assertGreaterThan('2026-11-18', $this->local($moves->first()['starts_at']), 'to a later day');
        $moved = $actions->pluck('event_id')->filter()->all();
        foreach ([$importantSession, $started, $fixed, $recurring] as $untouched) {
            $this->assertNotContains($untouched->id, $moved);
        }
        $this->assertStringContainsString('lowest priority', $moves->first()['reason']);
        $this->assertStringContainsString('booked', implode(' ', $response->json('proposal.explanation')));
        $this->assertSame(0, AssistantProposal::where('status', 'applied')->count());
    }

    public function test_prayer_windows_are_respected(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-02-03 08:00', 'UTC'));
        $this->setPrefs(['prayer_enabled' => true, 'prayer_lat' => 21.4225, 'prayer_lng' => 39.8262]);
        foreach (['A', 'B', 'C', 'D'] as $i => $title) {
            $this->task("Task {$title}", 90, 'high', $this->at('17:00', '2027-02-03'));
        }
        $windows = PrayerTimes::for($this->user->fresh())->protectedWindows('2027-02-03');
        $this->assertNotEmpty($windows);

        $actions = $this->actionsOf($this->reorganize());

        $this->assertGreaterThanOrEqual(3, count($actions));
        foreach ($actions as $action) {
            $s = CarbonImmutable::parse($action['starts_at']);
            $e = CarbonImmutable::parse($action['ends_at']);
            foreach ($windows as $w) {
                $this->assertFalse($s < $w[1] && $e > $w[0], "{$action['title']} {$action['starts_at']} avoids the prayer windows");
            }
        }
    }

    public function test_iftar_and_ramadan_hours_are_respected(): void
    {
        $first = CarbonImmutable::parse('2027-02-08');
        $this->setPrefs(['prayer_enabled' => true, 'prayer_lat' => 21.4225, 'prayer_lng' => 39.8262, 'ramadan_mode' => 'on', 'ramadan_work_start' => '10:00', 'ramadan_work_end' => '20:00', 'work_days' => [0, 1, 2, 3, 4, 5, 6]]);
        $day = $first->toDateString();
        $this->travelTo(CarbonImmutable::parse("{$day} 09:00", 'UTC'));
        $iftar = PrayerTimes::for($this->user->fresh())->iftar($day);
        $this->assertNotNull($iftar, 'Ramadan mode on: there is an iftar window');
        // Everything up to 20 minutes before iftar is busy, so the only free time that could take a session straddles the iftar window.
        $this->event('Long meeting', '10:00', $iftar['starts_at']->subMinutes(25)->format('H:i'), 'fixed', $day);
        $this->task('Evening review', 60, 'high', $this->at('23:00', $day));
        $this->task('Early one', 30, 'low', $this->at('23:00', $day));

        $actions = $this->actionsOf($this->reorganize());

        $this->assertCount(2, $actions);
        $windows = PrayerTimes::for($this->user->fresh())->protectedWindows($day);
        foreach ($actions as $action) {
            $s = CarbonImmutable::parse($action['starts_at']);
            $e = CarbonImmutable::parse($action['ends_at']);
            $this->assertGreaterThanOrEqual($this->at('10:00', $day), $s, 'inside the Ramadan hours (10:00-20:00), not the usual 09:00');
            $this->assertLessThanOrEqual($this->at('20:00', $day), $e);
            foreach ($windows as $w) {
                $this->assertFalse($s < $w[1] && $e > $w[0], 'avoids prayer and iftar');
            }
        }
        $this->assertGreaterThanOrEqual($iftar['ends_at'], CarbonImmutable::parse(collect($actions)->firstWhere('title', 'Evening review')['starts_at']), 'the 60-minute session starts after the iftar window');
    }

    public function test_low_energy_puts_shorter_tasks_first_and_high_energy_the_most_urgent_longest_first(): void
    {
        $long = $this->task('Long urgent', 120, 'urgent', $this->at('17:00'));
        $short = $this->task('Short chore', 30, 'low', $this->at('17:00'));
        $mid = $this->task('Mid task', 60, 'high', $this->at('17:00'));
        $order = fn (TestResponse $r) => collect($r->json('proposal.actions'))->sortBy('starts_at')->pluck('task_id')->all();

        $neutral = $this->reorganize()->assertOk();
        $this->assertSame([$long->id, $mid->id, $short->id], $order($neutral), 'no check-in: rank order');
        $this->assertStringNotContainsString('energy', strtolower(implode(' ', $neutral->json('proposal.explanation'))));

        DailyCheckin::create(['user_id' => $this->user->id, 'date' => '2026-11-18', 'energy' => 2]);
        $low = $this->reorganize()->assertOk();
        $this->assertSame([$short->id, $mid->id, $long->id], $order($low), 'energy 2: shortest first');
        $this->assertStringContainsString('shorter tasks come first', implode(' ', $low->json('proposal.explanation')));

        DailyCheckin::where('user_id', $this->user->id)->update(['energy' => 5]);
        $high = $this->reorganize()->assertOk();
        $this->assertSame([$long->id, $mid->id, $short->id], $order($high), 'energy 5: highest priority and longest first');
        $this->assertStringContainsString('highest-priority and longest', implode(' ', $high->json('proposal.explanation')));
    }

    public function test_nothing_to_do_returns_null_and_writes_no_row(): void
    {
        $this->task('Far away', 60, 'high', $this->at('17:00', '2026-12-01'));

        $this->reorganize()->assertOk()->assertJsonPath('proposal', null)->assertJsonPath('summary', 'Nothing has slipped: no missed sessions, nothing due without a session, and today is not overloaded.');
        $this->assertSame(0, AssistantProposal::count());
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_apply_creates_exactly_the_chosen_actions_once_and_undo_restores(): void
    {
        $a = $this->task('Report', 30, 'urgent', $this->at('17:00'));
        $b = $this->task('Email', 30, 'low', $this->at('17:00'));
        $proposal = $this->reorganize()->assertOk()->json('proposal');
        $this->assertCount(2, $proposal['actions']);
        $chosen = collect($proposal['actions'])->firstWhere('task_id', $a->id);

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => [$chosen['id']]])->assertOk()->assertJsonPath('status', 'applied');

        $this->assertSame([$a->id], CalendarEvent::pluck('task_id')->all(), 'exactly the chosen action');
        $this->assertSame(1, AuditLog::where('action', 'ai_action_executed')->count());
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => [$chosen['id']]])->assertUnprocessable();
        $this->assertSame(1, CalendarEvent::count(), 'a second apply creates nothing');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/undo")->assertOk()->assertJsonPath('status', 'undone');
        $this->assertSame(0, CalendarEvent::count());
        $this->assertSame(1, AuditLog::where('action', 'ai_action_undone')->count());
        $this->assertNotNull($b->fresh());
    }

    public function test_undo_of_an_overflow_move_puts_the_block_back(): void
    {
        $this->overflowDay();
        $original = CalendarEvent::where('title', 'Low priority errand')->firstOrFail();
        $before = $original->starts_at->toIso8601String();
        $proposal = $this->reorganize()->assertOk()->json('proposal');
        $move = collect($proposal['actions'])->firstWhere('type', 'move_event');
        $this->assertNotNull($move);

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => [$move['id']]])->assertOk();
        $this->assertNotSame($before, $original->fresh()->starts_at->toIso8601String());
        $this->assertSame(1, CalendarEvent::where('title', 'Low priority errand')->count(), 'moved, not copied');

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/undo")->assertOk();
        $this->assertSame($before, $original->fresh()->starts_at->toIso8601String());
    }

    public function test_a_slot_taken_meanwhile_is_refused_with_the_structured_conflict_and_nothing_is_applied(): void
    {
        $a = $this->task('Report', 30, 'urgent', $this->at('17:00'));
        $b = $this->task('Email', 30, 'high', $this->at('17:00'));
        $proposal = $this->reorganize()->assertOk()->json('proposal');
        $second = collect($proposal['actions'])->firstWhere('task_id', $b->id);
        $this->event('Surprise call', CarbonImmutable::parse($second['starts_at'])->format('H:i'), CarbonImmutable::parse($second['ends_at'])->format('H:i'));

        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1', 'a2']])
            ->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict')->assertJsonValidationErrors('actions');
        $this->assertSame(0, CalendarEvent::whereNotNull('task_id')->count(), 'the other action was not applied either');
        $this->assertSame('pending', AssistantProposal::first()->status);

        // The untouched action can still be applied on its own (per-action selection).
        $first = collect($proposal['actions'])->firstWhere('task_id', $a->id);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => [$first['id']]])->assertOk();
        $this->assertSame([$a->id], CalendarEvent::whereNotNull('task_id')->pluck('task_id')->all());
    }

    public function test_an_ordinary_task_never_ends_up_with_two_active_sessions(): void
    {
        $task = $this->task('Report', 60, 'high', $this->at('17:00'));
        $proposal = $this->reorganize()->assertOk()->json('proposal');
        $this->assertSame([$task->id], collect($proposal['actions'])->pluck('task_id')->all(), 'one session per task in a proposal');

        // The user books the task by hand before applying: the preview is refused instead of adding a second session.
        $this->block($task, '15:00', '16:00');
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal['id']}/apply", ['action_ids' => ['a1']])->assertUnprocessable()->assertJsonValidationErrors('actions');
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
        // And a fresh reorganize now proposes nothing for it.
        $this->reorganize()->assertOk()->assertJsonPath('proposal', null);
    }

    public function test_a_session_that_already_ended_does_not_count_as_active_and_a_split_task_may_get_another(): void
    {
        $ordinary = $this->task('Ordinary', 60, 'high', $this->at('17:00', '2026-11-20'));
        $this->block($ordinary, '09:00', '10:00');
        $split = $this->task('Split work', 180, 'medium', $this->at('17:00', '2026-11-20'), ['split_sessions' => true]);
        $this->block($split, '09:00', '10:00');
        $this->block($split, '16:00', '16:30');

        $actions = collect($this->actionsOf($this->reorganize()));

        $this->assertEqualsCanonicalizing([$ordinary->id, $split->id], $actions->pluck('task_id')->all());
        $this->assertSame(60, $actions->firstWhere('task_id', $ordinary->id)['minutes']);
    }

    public function test_closed_tasks_are_ignored_and_their_sessions_do_not_hold_time(): void
    {
        $done = $this->task('Done already', 60, 'urgent', $this->at('17:00'), ['status' => 'completed', 'completed_at' => now()]);
        $this->block($done, '09:00', '10:00');
        $cancelled = $this->task('Cancelled', 60, 'urgent', $this->at('10:00'), ['status' => 'cancelled']);
        $open = $this->task('Open one', 60, 'high', $this->at('17:00'));
        // A completed task's later block still sits on the calendar but no longer holds the time.
        $closedLater = $this->task('Finished early', 45, 'low', null, ['status' => 'completed', 'completed_at' => now()]);
        $this->block($closedLater, '11:00', '16:55');

        $actions = $this->actionsOf($this->reorganize());

        $this->assertSame([$open->id], array_column($actions, 'task_id'));
        $this->assertSame('2026-11-18 11:15', $this->local($actions[0]['starts_at']), 'the closed task’s block does not occupy 11:00-16:55');
        $this->assertNotContains($cancelled->id, array_column($actions, 'task_id'));
    }

    public function test_another_users_data_is_never_used_or_leaked(): void
    {
        $other = $this->makeUser();
        $theirTask = $this->task('Their secret task', 60, 'urgent', $this->at('10:00'), [], $other);
        $this->block($theirTask, '09:00', '10:00');
        $this->event('Their blocker', '11:00', '17:00', 'fixed', '2026-11-18', [], $other);
        $mine = $this->task('My task', 60, 'high', $this->at('17:00'));

        $response = $this->reorganize()->assertOk();

        $this->assertSame([$mine->id], array_column($response->json('proposal.actions'), 'task_id'));
        $this->assertSame('2026-11-18 11:15', $this->local($response->json('proposal.actions.0.starts_at')), 'their calendar is not my busy time');
        $this->assertStringNotContainsString('secret', $response->getContent());
        $id = $response->json('proposal.id');
        $this->actingAs($other)->getJson("/api/assistant/proposals/{$id}")->assertNotFound();
        $this->actingAs($other)->postJson("/api/assistant/proposals/{$id}/apply", ['action_ids' => ['a1']])->assertNotFound();
        $this->assertSame(0, AssistantProposal::where('user_id', $other->id)->count());
        $this->assertNotContains($id, collect($this->actingAs($other)->getJson('/api/assistant/proposals')->json())->pluck('id')->all());
    }

    public function test_guests_are_refused(): void
    {
        $this->postJson('/api/today/reorganize')->assertUnauthorized();
    }

    public function test_a_dst_day_europe_amsterdam_keeps_every_session_in_real_free_time(): void
    {
        $this->user = $this->makeUser(['timezone' => 'Europe/Amsterdam', 'work_start' => '01:00', 'work_end' => '06:00', 'work_days' => [0, 1, 2, 3, 4, 5, 6]]);
        $this->travelTo(CarbonImmutable::parse('2027-03-28 00:00', 'Europe/Amsterdam'));
        foreach (['One', 'Two', 'Three'] as $title) {
            $this->task($title, 60, 'high', CarbonImmutable::parse('2027-03-28 23:00', 'Europe/Amsterdam')->utc());
        }

        $actions = collect($this->actionsOf($this->reorganize()))->sortBy('starts_at')->values();

        $this->assertCount(3, $actions);
        $previousEnd = null;
        foreach ($actions as $action) {
            $s = CarbonImmutable::parse($action['starts_at']);
            $e = CarbonImmutable::parse($action['ends_at']);
            $this->assertSame(60, (int) $s->diffInMinutes($e), 'real elapsed minutes across the gap');
            $this->assertNotSame('02', $s->setTimezone('Europe/Amsterdam')->format('H'), 'no session starts in the non-existent 02:00-03:00');
            $this->assertLessThanOrEqual(CarbonImmutable::parse('2027-03-28 06:00', 'Europe/Amsterdam'), $e);
            $this->assertGreaterThanOrEqual(CarbonImmutable::parse('2027-03-28 01:00', 'Europe/Amsterdam'), $s);
            $previousEnd && $this->assertGreaterThanOrEqual($previousEnd->addMinutes(10), $s, 'a break between sessions');
            $previousEnd = $e;
        }
    }

    public function test_a_user_in_a_far_east_zone_near_local_midnight_gets_the_next_work_day(): void
    {
        $zone = 'Pacific/Auckland';
        $this->user = $this->makeUser(['timezone' => $zone]);
        $this->travelTo(CarbonImmutable::parse('2026-11-18 23:50', $zone));
        $this->assertSame('2026-11-18', CarbonImmutable::now()->utc()->toDateString(), 'it is still the 18th in UTC, but late on the 18th for this user');
        $missed = $this->task('Missed lesson', 60, 'medium', CarbonImmutable::parse('2026-11-25 17:00', $zone)->utc());
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $missed->id, 'title' => 'Missed lesson', 'starts_at' => CarbonImmutable::parse('2026-11-18 14:00', $zone)->utc(), 'ends_at' => CarbonImmutable::parse('2026-11-18 15:00', $zone)->utc(), 'kind' => 'flexible']);
        $due = $this->task('Due today', 30, 'high', CarbonImmutable::parse('2026-11-18 23:59', $zone)->utc());

        $actions = collect($this->actionsOf($this->reorganize()))->keyBy('task_id');

        $this->assertCount(2, $actions);
        $this->assertSame('2026-11-19 09:00', $this->local($actions[$due->id]['starts_at'], $zone), 'the work day has ended: the next work day, in the account zone');
        $this->assertSame('2026-11-19 09:40', $this->local($actions[$missed->id]['starts_at'], $zone));
        $this->assertStringContainsString('tomorrow', $actions[$missed->id]['reason']);
    }

    public function test_no_provider_is_called_and_nothing_is_sent_out(): void
    {
        Http::fake();
        config(['ai.provider' => 'openai']);
        $this->task('Private title for the bank', 30, 'high', $this->at('17:00'));

        $this->reorganize()->assertOk()->assertJsonCount(1, 'proposal.actions');

        Http::assertNothingSent();
    }

    public function test_the_today_hint_counts_missed_unscheduled_and_overload_without_changing_other_keys(): void
    {
        $this->getJson('/api/today')->assertUnauthorized();
        $quiet = $this->actingAs($this->user)->getJson('/api/today')->assertOk()->assertJsonPath('reorganize', ['missed' => 0, 'due_unscheduled' => 0, 'overloaded' => false])->json();
        foreach (['date', 'period', 'briefing', 'energy', 'focus_time', 'timeline', 'deadlines', 'progress', 'windows', 'timezone', 'day_start'] as $key) {
            $this->assertArrayHasKey($key, $quiet);
        }

        $missed = $this->task('Missed', 60, 'medium', $this->at('17:00', '2026-11-20'));
        $this->block($missed, '09:00', '10:00');
        $this->task('Due', 30, 'high', $this->at('16:00'));
        $this->task('Booked', 30, 'high', $this->at('16:00'));
        $booked = Task::where('title', 'Booked')->first();
        $this->block($booked, '14:00', '14:30');
        $this->getJson('/api/today')->assertOk()->assertJsonPath('reorganize', ['missed' => 1, 'due_unscheduled' => 1, 'overloaded' => false]);

        $this->event('Marathon meeting', '11:20', '16:50');
        $this->assertTrue($this->getJson('/api/today')->assertOk()->json('reorganize.overloaded'));
    }

    public function test_the_same_open_preview_is_returned_within_ten_minutes_but_not_after_it_changes(): void
    {
        $this->task('Report', 30, 'high', $this->at('17:00'));
        $first = $this->reorganize()->assertOk()->json('proposal.id');

        $this->travelTo(CarbonImmutable::parse('2026-11-18 11:04', 'UTC'));
        $this->assertSame($first, $this->reorganize()->assertOk()->json('proposal.id'), 'same actions: the open preview is returned');
        $this->assertSame(1, AssistantProposal::count());

        $this->task('New urgent', 30, 'urgent', $this->at('17:00'));
        $second = $this->reorganize()->assertOk()->json('proposal.id');
        $this->assertNotSame($first, $second, 'different actions: a new preview');
        $this->assertSame('dismissed', AssistantProposal::find($first)->status, 'the older open preview is withdrawn');

        $this->travelTo(CarbonImmutable::parse('2026-11-18 11:20', 'UTC'));
        $third = $this->reorganize()->assertOk()->json('proposal.id');
        $this->assertNotSame($second, $third, 'after ten minutes a fresh one is made');
    }

    public function test_the_proposal_is_capped_at_twelve_actions(): void
    {
        foreach (range(1, 14) as $i) {
            $this->task("Quick {$i}", 15, 'medium', $this->at('17:00'));
        }

        $response = $this->reorganize()->assertOk();

        $this->assertCount(12, $response->json('proposal.actions'));
        $this->assertStringContainsString('Limit of 12 changes', implode(' ', $response->json('proposal.explanation')));
    }

    public function test_work_that_does_not_fit_anywhere_is_reported_with_a_suggestion_and_no_row(): void
    {
        foreach (range(0, 13) as $d) {
            $this->event("Busy {$d}", '00:00', '23:59', 'fixed', CarbonImmutable::parse('2026-11-18')->addDays($d)->toDateString());
        }
        $this->task('Impossible job', 60, 'high', $this->at('17:00'));

        $response = $this->reorganize()->assertOk()->assertJsonPath('proposal', null);

        $this->assertStringContainsString('splitting or dropping', $response->json('summary'));
        $this->assertStringContainsString('Impossible job', $response->json('summary'));
        $this->assertSame(0, AssistantProposal::count());
    }

    public function test_a_deadline_before_the_only_free_slot_is_flagged(): void
    {
        $this->event('Workshop', '11:00', '17:00');
        $task = $this->task('Submit form', 30, 'high', $this->at('15:00'));

        $response = $this->reorganize()->assertOk();
        $action = $response->json('proposal.actions.0');

        $this->assertSame($task->id, $action['task_id']);
        $this->assertSame('2026-11-19 09:00', $this->local($action['starts_at']));
        $this->assertStringContainsString('after its deadline', $action['reason']);
        $this->assertStringContainsString('after their deadline', implode(' ', $response->json('proposal.explanation')));
    }

    public function test_a_session_is_shortened_into_the_room_that_is_left_today(): void
    {
        $this->event('Workshop', '12:10', '17:00');
        $task = $this->task('Draft essay', 120, 'high', $this->at('17:00'));

        $response = $this->reorganize()->assertOk();
        $action = $response->json('proposal.actions.0');

        $this->assertSame($task->id, $action['task_id']);
        $this->assertSame('2026-11-18 11:15', $this->local($action['starts_at']));
        $this->assertSame(55, $action['minutes'], 'the 55 minutes of room before the workshop');
        $this->assertStringContainsString('Shortened', implode(' ', $response->json('proposal.explanation')));
    }

    public function test_arabic_accounts_get_arabic_reasons_and_summary(): void
    {
        $this->setPrefs(['language' => 'ar']);
        $this->task('تقرير', 30, 'high', $this->at('17:00'));

        $response = $this->reorganize()->assertOk();

        $this->assertMatchesRegularExpression('/\p{Arabic}/u', $response->json('proposal.actions.0.reason'));
        $this->assertMatchesRegularExpression('/\p{Arabic}/u', $response->json('summary'));
        $this->assertMatchesRegularExpression('/\p{Arabic}/u', implode(' ', $response->json('proposal.explanation')));
    }

    public function test_a_connected_calendar_event_blocks_the_slot(): void
    {
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@example.com', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'primary', 'external_id' => 'x1', 'title' => 'Google meeting', 'starts_at' => $this->at('11:00'), 'ends_at' => $this->at('13:00')]);
        $this->task('Report', 30, 'high', $this->at('17:00'));

        $this->assertSame('2026-11-18 13:10', $this->local($this->actionsOf($this->reorganize())[0]['starts_at']), 'after the Google event and a break');
    }

    /** A full day with one missed task and flexible sessions of different priority (the overflow scenario). */
    private function overflowDay(): void
    {
        $missed = $this->task('Missed deep work', 60, 'high', $this->at('17:00', '2026-11-20'));
        $this->block($missed, '09:00', '10:00');
        $low = $this->task('Low priority errand', 60, 'low', $this->at('17:00', '2026-11-25'));
        $important = $this->task('Important prep', 60, 'urgent', $this->at('17:00', '2026-11-25'));
        $this->block($low, '14:10', '15:10');
        $this->block($important, '15:20', '16:20');
        $this->event('Started flexible block', '10:30', '11:30', 'flexible');
        $this->event('Board meeting', '11:40', '14:00', 'fixed');
        $this->event('Daily standup', '16:30', '17:00', 'flexible', '2026-11-18', ['recurrence' => ['freq' => 'daily'], 'timezone' => 'UTC']);
    }
}
