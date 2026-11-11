<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\CalendarEvent;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\AssistantActions;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * An ordinary task has at most one active calendar session (non-recurring event linked to the task that has not ended). A task marked
 * split_sessions (an accepted multi-block plan) may have several.
 */
class TaskSchedulingIntegrityTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
    }

    /** @return array{starts_at: string, ends_at: string} */
    private function slot(string $day = '2027-02-03', string $from = '09:00', string $to = '10:00'): array
    {
        return ['starts_at' => "{$day}T{$from}:00Z", 'ends_at' => "{$day}T{$to}:00Z"];
    }

    private function makeSession(Task $task, string $start, string $end, ?User $user = null): CalendarEvent
    {
        return CalendarEvent::factory()->flexible()->create(['user_id' => ($user ?? $this->user)->id, 'task_id' => $task->id, 'title' => $task->title, 'starts_at' => $start, 'ends_at' => $end]);
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function task(User $owner, bool $split = false, array $attributes = []): Task
    {
        return Task::factory()->create(['user_id' => $owner->id, 'split_sessions' => $split] + $attributes);
    }

    private function taskSessions(Task $task): int
    {
        return CalendarEvent::where('task_id', $task->id)->count();
    }

    public function test_an_unscheduled_task_can_be_scheduled_once(): void
    {
        $task = $this->task($this->user);

        $response = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertCreated()
            ->assertJsonPath('data.task_id', $task->id)
            ->assertJsonPath('data.title', $task->title)
            ->assertJsonPath('data.kind', 'flexible')
            ->assertJsonPath('schedule.sessions', 1)
            ->assertJsonPath('schedule.split', false)
            ->assertJsonPath('schedule.starts_at', '2027-02-03T09:00:00Z')
            ->assertJsonPath('schedule.ends_at', '2027-02-03T10:00:00Z');
        $this->assertSame($response->json('data.id'), $response->json('schedule.session_id'));
        $this->assertSame(1, $this->taskSessions($task));
    }

    public function test_a_second_schedule_is_a_409_with_the_existing_session_and_creates_no_row(): void
    {
        $task = $this->task($this->user);
        $first = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertCreated();

        $response = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04', '11:00', '12:00'))->assertStatus(409)
            ->assertJsonPath('code', 'task_already_scheduled')
            ->assertJsonPath('session.id', $first->json('data.id'))
            ->assertJsonPath('session.task_id', $task->id)
            ->assertJsonPath('session.starts_at', '2027-02-03T09:00:00Z')
            ->assertJsonPath('session.ends_at', '2027-02-03T10:00:00Z');
        $this->assertNotEmpty($response->json('message'));
        $this->assertSame(1, $this->taskSessions($task));
    }

    public function test_two_requests_in_a_row_create_one_session(): void
    {
        // True parallelism cannot be simulated inside one PHPUnit process (one DB connection, one thread). What this checks is the outcome of the
        // interleaving the row lock produces in production: the later request runs after the earlier one has committed and sees its session.
        $task = $this->task($this->user);

        $codes = collect([['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '14:00']])->map(fn (array $t) => $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-03', ...$t))->status());

        $this->assertSame([201, 409, 409], $codes->all());
        $this->assertSame(1, $this->taskSessions($task));
    }

    public function test_the_guard_runs_in_a_transaction_that_locks_the_task_row_before_inserting(): void
    {
        // Real mutual exclusion needs PostgreSQL row locks (SQLite takes no row locks and serialises writers by itself). Here we assert the shape that
        // provides it: SELECT ... FOR UPDATE on tasks, inside a transaction opened by the request (level above the test's own), before the INSERT.
        $task = $this->task($this->user);
        $baseLevel = DB::transactionLevel();
        $log = [];
        DB::listen(function ($query) use (&$log) {
            $log[] = ['sql' => strtolower($query->sql), 'level' => DB::transactionLevel()];
        });

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertCreated();

        $lock = collect($log)->search(fn ($q) => str_contains($q['sql'], 'from "tasks"') && $q['level'] > $baseLevel);
        $insert = collect($log)->search(fn ($q) => str_starts_with($q['sql'], 'insert into "calendar_events"'));
        $this->assertNotFalse($lock, 'the task is read inside the request transaction');
        $this->assertNotFalse($insert);
        $this->assertLessThan($insert, $lock);
        $this->assertGreaterThan($baseLevel, $log[$insert]['level']);
        if (DB::getDriverName() === 'pgsql') {
            $locking = collect($log)->first(fn ($q) => str_contains($q['sql'], 'from "tasks"') && str_contains($q['sql'], 'for update'));
            $this->assertNotNull($locking, 'SELECT ... FOR UPDATE on the task row');
        }
    }

    public function test_put_moves_the_existing_session_and_never_creates_one(): void
    {
        $task = $this->task($this->user);
        $id = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->json('data.id');

        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-05', '14:00', '15:30'))->assertOk()
            ->assertJsonPath('data.id', $id)
            ->assertJsonPath('schedule.session_id', $id)
            ->assertJsonPath('schedule.starts_at', '2027-02-05T14:00:00Z')
            ->assertJsonPath('schedule.ends_at', '2027-02-05T15:30:00Z');
        $this->assertSame(1, $this->taskSessions($task));
        $moved = CalendarEvent::findOrFail($id);
        $this->assertSame('2027-02-05 14:00:00', $moved->starts_at->utc()->format('Y-m-d H:i:s'));
        $this->assertSame('2027-02-05 15:30:00', $moved->ends_at->utc()->format('Y-m-d H:i:s'));
    }

    public function test_put_without_a_session_is_a_404_with_a_code(): void
    {
        $task = $this->task($this->user);

        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertNotFound()->assertJsonPath('code', 'task_not_scheduled');
        $this->assertSame(0, $this->taskSessions($task));
    }

    public function test_put_needs_a_session_id_when_a_split_task_has_several_sessions(): void
    {
        $task = $this->task($this->user, true);
        $a = $this->makeSession($task, '2027-02-03 09:00', '2027-02-03 10:00');
        $b = $this->makeSession($task, '2027-02-04 09:00', '2027-02-04 10:00');

        $response = $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-06', '09:00', '10:00'))->assertStatus(409)->assertJsonPath('code', 'task_has_several_sessions');
        $this->assertSame([$a->id, $b->id], collect($response->json('sessions'))->pluck('id')->all());

        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-06', '09:00', '10:00') + ['session_id' => $b->id])->assertOk()->assertJsonPath('data.id', $b->id)
            ->assertJsonPath('schedule.session_id', $a->id)
            ->assertJsonPath('schedule.sessions', 2);
        $this->assertSame('2027-02-03 09:00:00', $a->fresh()->starts_at->format('Y-m-d H:i:s'));
        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-06', '12:00', '13:00') + ['session_id' => 999999])->assertNotFound()->assertJsonPath('code', 'session_not_found');
        $this->assertSame(2, $this->taskSessions($task));
    }

    public function test_put_keeps_the_calendar_rules_of_events(): void
    {
        $task = $this->task($this->user);
        $id = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->json('data.id');
        CalendarEvent::factory()->create(['user_id' => $this->user->id, 'title' => 'Dentist', 'kind' => 'fixed', 'starts_at' => '2027-02-05 14:00', 'ends_at' => '2027-02-05 15:00']);

        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-05', '14:30', '15:30'))->assertUnprocessable()->assertJsonValidationErrors('starts_at');
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-05', '14:30', '15:30'))->assertStatus(409);
        $this->assertSame('2027-02-03 09:00:00', CalendarEvent::findOrFail($id)->starts_at->format('Y-m-d H:i:s'));

        // A fixed session asks for confirmation before it moves, exactly like PATCH /api/events/{id}.
        CalendarEvent::whereKey($id)->update(['kind' => 'fixed']);
        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-06'))->assertUnprocessable()->assertJsonValidationErrors('fixed');
        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-06') + ['confirm_fixed' => true])->assertOk()->assertJsonPath('data.id', $id);
    }

    public function test_scheduling_checks_conflicts_and_the_future_like_events(): void
    {
        $task = $this->task($this->user);
        CalendarEvent::factory()->create(['user_id' => $this->user->id, 'title' => 'Dentist', 'kind' => 'fixed', 'starts_at' => '2027-02-03 09:30', 'ends_at' => '2027-02-03 10:30']);

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertUnprocessable()->assertJsonValidationErrors('starts_at');
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-01-30'))->assertUnprocessable()->assertJsonValidationErrors('ends_at');
        $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2027-02-04T10:00:00Z', 'ends_at' => '2027-02-04T09:00:00Z'])->assertUnprocessable();
        $this->assertSame(0, $this->taskSessions($task));
    }

    public function test_a_split_task_allows_several_sessions(): void
    {
        $task = $this->task($this->user, true);
        $this->makeSession($task, '2027-02-03 09:00', '2027-02-03 10:00');

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04'))->assertCreated()->assertJsonPath('schedule.sessions', 2)->assertJsonPath('schedule.split', true);
        $this->postJson('/api/events', ['title' => 'Third', 'task_id' => $task->id] + $this->slot('2027-02-05'))->assertCreated();
        $this->assertTrue($task->fresh()->split_sessions);
        $this->assertSame(3, $this->taskSessions($task));
    }

    public function test_post_events_with_a_task_is_guarded_too(): void
    {
        $task = $this->task($this->user);
        $first = $this->postJson('/api/events', ['title' => 'Work', 'kind' => 'flexible', 'task_id' => $task->id] + $this->slot())->assertCreated();

        $this->postJson('/api/events', ['title' => 'Work again', 'task_id' => $task->id] + $this->slot('2027-02-04'))->assertStatus(409)
            ->assertJsonPath('code', 'task_already_scheduled')->assertJsonPath('session.id', $first->json('data.id'));
        $this->assertSame(1, $this->taskSessions($task));
        // Events without a task, recurring events and events that are over are not sessions.
        $this->postJson('/api/events', ['title' => 'Plain'] + $this->slot('2027-02-04'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'Series', 'task_id' => $task->id, 'recurrence' => ['freq' => 'weekly', 'by_weekday' => [3]]] + $this->slot('2027-02-10'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'Logged work', 'task_id' => $task->id] + $this->slot('2027-01-25'))->assertCreated();
    }

    public function test_changing_an_events_task_onto_a_scheduled_task_is_refused(): void
    {
        $busy = $this->task($this->user);
        $free = $this->task($this->user);
        $this->makeSession($busy, '2027-02-03 09:00', '2027-02-03 10:00');
        $other = $this->makeSession($free, '2027-02-04 09:00', '2027-02-04 10:00');
        $plain = CalendarEvent::factory()->create(['user_id' => $this->user->id, 'starts_at' => '2027-02-05 09:00', 'ends_at' => '2027-02-05 10:00']);

        $this->patchJson("/api/events/{$other->id}", ['task_id' => $busy->id])->assertStatus(409)->assertJsonPath('code', 'task_already_scheduled');
        $this->patchJson("/api/events/{$plain->id}", ['task_id' => $busy->id])->assertStatus(409);
        $this->assertSame($free->id, $other->fresh()->task_id);
        $this->assertNull($plain->fresh()->task_id);
        $this->assertSame(1, $this->taskSessions($busy));
        // Moving a session of the task itself, or relinking onto an unscheduled task, is fine.
        $this->patchJson("/api/events/{$other->id}", ['starts_at' => '2027-02-04T11:00:00Z', 'ends_at' => '2027-02-04T12:00:00Z'])->assertOk();
        $this->patchJson("/api/events/{$plain->id}", ['task_id' => $this->task($this->user)->id])->assertOk();
    }

    public function test_assistant_create_event_is_refused_for_a_scheduled_task_and_creates_nothing(): void
    {
        $task = $this->task($this->user);
        $this->makeSession($task, '2027-02-03 09:00', '2027-02-03 10:00');
        $fresh = $this->task($this->user);
        $proposal = AssistantProposal::create([
            'user_id' => $this->user->id, 'kind' => 'schedule', 'provider' => 'local', 'summary' => 'x', 'explanation' => [], 'expires_at' => now()->addHour(),
            'actions' => [
                ['id' => 'a1', 'type' => 'create_event', 'title' => 'Fresh', 'task_id' => $fresh->id, 'starts_at' => '2027-02-03T13:00:00+00:00', 'ends_at' => '2027-02-03T14:00:00+00:00', 'minutes' => 60],
                ['id' => 'a2', 'type' => 'create_event', 'title' => $task->title, 'task_id' => $task->id, 'starts_at' => '2027-02-04T13:00:00+00:00', 'ends_at' => '2027-02-04T14:00:00+00:00', 'minutes' => 60],
            ],
        ]);
        $before = CalendarEvent::count();

        $response = $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1', 'a2']])->assertUnprocessable()->assertJsonValidationErrors('actions');
        $this->assertStringContainsString('already scheduled', $response->json('errors.actions.0'));
        $this->assertSame($before, CalendarEvent::count(), 'nothing is created, not even the valid action');
        $this->assertSame('pending', $proposal->fresh()->status);

        $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertSame(1, $this->taskSessions($fresh));
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function twoBlocks(Task $task, bool $split): array
    {
        $extra = $split ? ['split' => true] : [];

        return [
            ['id' => 'a1', 'type' => 'create_event', 'title' => $task->title, 'task_id' => $task->id, 'starts_at' => '2027-02-03T09:00:00+00:00', 'ends_at' => '2027-02-03T10:00:00+00:00', 'minutes' => 60] + $extra,
            ['id' => 'a2', 'type' => 'create_event', 'title' => $task->title, 'task_id' => $task->id, 'starts_at' => '2027-02-03T13:00:00+00:00', 'ends_at' => '2027-02-03T14:00:00+00:00', 'minutes' => 60] + $extra,
        ];
    }

    private function proposal(array $actions): AssistantProposal
    {
        return AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'focus_blocks', 'provider' => 'local', 'summary' => 'x', 'explanation' => [], 'expires_at' => now()->addHour(), 'actions' => $actions]);
    }

    public function test_only_blocks_the_planner_marked_split_make_a_task_split(): void
    {
        $planned = $this->task($this->user);
        $this->postJson("/api/assistant/proposals/{$this->proposal($this->twoBlocks($planned, true))->id}/apply", ['action_ids' => ['a1', 'a2']])->assertOk();
        $this->assertSame(2, $this->taskSessions($planned));
        $this->assertTrue($planned->fresh()->split_sessions);

        // Two plain create_event actions for one task are NOT an explicit split: the second is refused and nothing is created.
        $plain = $this->task($this->user);
        $this->postJson("/api/assistant/proposals/{$this->proposal($this->twoBlocks($plain, false))->id}/apply", ['action_ids' => ['a1', 'a2']])->assertUnprocessable();
        $this->assertSame(0, $this->taskSessions($plain));
        $this->assertFalse($plain->fresh()->split_sessions);
    }

    public function test_a_split_plan_for_a_task_that_already_has_a_session_is_refused_on_apply_and_accept(): void
    {
        $task = $this->task($this->user);
        $this->makeSession($task, '2027-02-04 09:00', '2027-02-04 10:00');
        $proposal = $this->proposal($this->twoBlocks($task, true));
        $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1', 'a2']])->assertUnprocessable();
        $this->assertSame(1, $this->taskSessions($task));
        $this->assertFalse($task->fresh()->split_sessions);

        $plan = $this->proposalFor([$this->manualItem($task, '2027-02-03T09:00:00+00:00', '2027-02-03T10:00:00+00:00', 1, 2), $this->manualItem($task, '2027-02-03T13:00:00+00:00', '2027-02-03T14:00:00+00:00', 2, 2)]);
        $this->postJson("/api/plans/{$plan->id}/accept")->assertUnprocessable();
        $this->assertSame(1, $this->taskSessions($task));
        $this->assertFalse($task->fresh()->split_sessions);
    }

    public function test_a_split_task_with_no_active_session_left_starts_a_new_cycle(): void
    {
        $task = $this->task($this->user, true);
        $this->makeSession($task, '2027-01-20 09:00', '2027-01-20 10:00');

        // POST /api/events
        $this->postJson('/api/events', ['title' => 'Again', 'task_id' => $task->id] + $this->slot('2027-02-03'))->assertCreated();
        $this->assertFalse($task->fresh()->split_sessions);
        $this->postJson('/api/events', ['title' => 'Once more', 'task_id' => $task->id] + $this->slot('2027-02-04'))->assertStatus(409);

        // Assistant create_event (a single plain block).
        $other = $this->task($this->user, true);
        $proposal = $this->proposal([['id' => 'a1', 'type' => 'create_event', 'title' => $other->title, 'task_id' => $other->id, 'starts_at' => '2027-02-03T13:00:00+00:00', 'ends_at' => '2027-02-03T14:00:00+00:00', 'minutes' => 60]]);
        $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertFalse($other->fresh()->split_sessions);

        // Manual relink (PATCH).
        $third = $this->task($this->user, true);
        $event = CalendarEvent::factory()->create(['user_id' => $this->user->id, 'starts_at' => '2027-02-05 09:00', 'ends_at' => '2027-02-05 10:00']);
        $this->patchJson("/api/events/{$event->id}", ['task_id' => $third->id])->assertOk();
        $this->assertFalse($third->fresh()->split_sessions);

        // A split task that still has an active session keeps its flag.
        $live = $this->task($this->user, true);
        $this->makeSession($live, '2027-02-06 09:00', '2027-02-06 10:00');
        $this->postJson("/api/tasks/{$live->id}/schedule", $this->slot('2027-02-07'))->assertCreated();
        $this->assertTrue($live->fresh()->split_sessions);
    }

    public function test_an_identical_request_without_a_key_replays_instead_of_a_409(): void
    {
        $task = $this->task($this->user);
        $first = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertCreated();

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertOk()->assertHeader('Idempotent-Replay', 'true')->assertJsonPath('data.id', $first->json('data.id'));
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-03', '09:00', '10:30'))->assertStatus(409);

        $other = $this->task($this->user);
        $body = ['title' => 'Work', 'task_id' => $other->id] + $this->slot('2027-02-05');
        $a = $this->postJson('/api/events', $body)->assertCreated();
        $this->postJson('/api/events', $body)->assertOk()->assertHeader('Idempotent-Replay', 'true')->assertJsonPath('data.id', $a->json('data.id'));
        $this->postJson('/api/events', ['title' => 'Different title'] + $body)->assertStatus(409);
        $this->assertSame(1, $this->taskSessions($other));
        $this->assertSame(1, $this->taskSessions($task));
    }

    public function test_completed_and_cancelled_tasks_cannot_be_scheduled_or_moved(): void
    {
        foreach (['completed', 'cancelled'] as $status) {
            $task = $this->task($this->user, false, ['status' => $status]);
            $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertUnprocessable()->assertJsonValidationErrors('task');
            $this->makeSession($task, '2027-02-04 09:00', '2027-02-04 10:00');
            $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-05'))->assertUnprocessable()->assertJsonValidationErrors('task');
            $this->assertSame(1, $this->taskSessions($task));
        }
    }

    public function test_planners_do_not_propose_a_block_for_a_task_that_already_has_a_session(): void
    {
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [0, 1, 2, 3, 4, 5, 6]]]);
        $busy = $this->task($this->user, false, ['title' => 'Already booked', 'estimated_minutes' => 120, 'due_at' => '2027-02-10T17:00:00Z']);
        $free = $this->task($this->user, false, ['title' => 'Still free', 'estimated_minutes' => 60, 'due_at' => '2027-02-10T17:00:00Z']);
        $this->makeSession($busy, '2027-02-02 15:00', '2027-02-02 15:30');

        // Week planner.
        $titles = collect($this->postJson('/api/plans', ['date' => '2027-02-01', 'days' => 5])->assertCreated()->json('items'))->pluck('title');
        $this->assertContains('Still free', $titles->all());
        $this->assertNotContains('Already booked', $titles->all());

        // Day planner (every variant).
        $day = $this->getJson('/api/day-plan?date=2027-02-02')->assertOk()->json();
        $dayTitles = collect($day['alternatives'])->flatMap(fn (array $v) => collect($v['items'])->pluck('title'))->all();
        $this->assertContains('Still free', $dayTitles);
        $this->assertNotContains('Already booked', $dayTitles);

        // Copilot/assistant planners.
        $actions = app(AssistantActions::class);
        $proposal = $actions->proposeSchedule($this->user, '2027-02-03', 240, [['title' => 'Already booked', 'task_id' => $busy->id], ['title' => 'Still free', 'task_id' => $free->id], ['title' => 'Still free', 'task_id' => $free->id]], null, false, 'local');
        $this->assertSame(['Still free'], collect($proposal->actions)->pluck('title')->all(), 'a task listed twice is one block, a booked task none');
        $find = $actions->proposeFindTime($this->user, collect([$busy, $free]), 'x', false, 'local');
        $this->assertSame([$free->id], collect($find->actions)->pluck('task_id')->all());
        // Whatever was proposed can be applied.
        $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1']])->assertOk();
    }

    private function manualItem(Task $task, string $start, string $end, int $part = 1, int $parts = 1): array
    {
        return ['key' => "{$task->id}-{$part}", 'task_id' => $task->id, 'task_version' => $task->updated_at->toISOString(), 'title' => $task->title, 'priority' => 'medium', 'starts_at' => $start, 'ends_at' => $end,
            'minutes' => (int) CarbonImmutable::parse($start)->diffInMinutes($end), 'part' => $part, 'parts' => $parts, 'manual' => true, 'reasons' => ['manual'], 'explanation' => 'x'];
    }

    private function proposalFor(array $items): ScheduleProposal
    {
        return ScheduleProposal::factory()->create(['user_id' => $this->user->id, 'status' => 'pending', 'items' => $items, 'starts_on' => '2027-02-03', 'days' => 1, 'warnings' => [], 'summary' => []]);
    }

    public function test_accepting_a_generated_two_block_plan_marks_the_task_split_and_keeps_both_blocks(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-01-04 08:00', 'UTC'));
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Study', 'estimated_minutes' => 90, 'due_at' => '2027-01-04T18:00:00Z']);
        CalendarEvent::factory()->create(['user_id' => $this->user->id, 'title' => 'Fixed', 'kind' => 'fixed', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T10:00:00Z']);
        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->assertCreated()->json();
        $this->assertCount(2, $plan['items']);

        $this->postJson('/api/plans/'.$plan['id'].'/accept')->assertOk();

        $this->assertSame(2, $this->taskSessions($task));
        $this->assertTrue($task->fresh()->split_sessions);
        $this->getJson('/api/tasks')->assertOk()->assertJsonPath('data.0.schedule.sessions', 2)->assertJsonPath('data.0.schedule.split', true);
    }

    public function test_accepting_a_single_block_plan_does_not_mark_the_task_split(): void
    {
        $task = $this->task($this->user);
        $plan = $this->proposalFor([$this->manualItem($task, '2027-02-03T09:00:00+00:00', '2027-02-03T10:00:00+00:00')]);

        $this->postJson("/api/plans/{$plan->id}/accept")->assertOk();

        $this->assertSame(1, $this->taskSessions($task));
        $this->assertFalse($task->fresh()->split_sessions);
    }

    public function test_accepting_a_plan_that_would_add_a_second_session_to_an_ordinary_task_is_refused(): void
    {
        $task = $this->task($this->user);
        $this->makeSession($task, '2027-02-04 09:00', '2027-02-04 10:00');
        $other = $this->task($this->user);
        $plan = $this->proposalFor([$this->manualItem($other, '2027-02-03T09:00:00+00:00', '2027-02-03T10:00:00+00:00'), $this->manualItem($task, '2027-02-03T13:00:00+00:00', '2027-02-03T14:00:00+00:00')]);

        $this->postJson("/api/plans/{$plan->id}/accept")->assertUnprocessable()->assertJsonValidationErrors('proposal');

        $this->assertSame(1, $this->taskSessions($task));
        $this->assertSame(0, $this->taskSessions($other), 'all or nothing');
        $this->assertSame('pending', $plan->fresh()->status);
        $this->assertFalse($task->fresh()->split_sessions);
    }

    public function test_a_past_session_does_not_block_a_new_one(): void
    {
        $task = $this->task($this->user);
        $this->makeSession($task, '2027-01-28 09:00', '2027-01-28 10:00');
        $this->makeSession($task, '2027-02-01 07:00', '2027-02-01 07:59');

        $this->getJson('/api/tasks')->assertJsonPath('data.0.schedule', null);
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot())->assertCreated()->assertJsonPath('schedule.sessions', 1);
        // An event running right now is still active.
        $this->travelTo(CarbonImmutable::parse('2027-02-03 09:30', 'UTC'));
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04'))->assertStatus(409);
        $this->travelTo(CarbonImmutable::parse('2027-02-03 10:00:01', 'UTC'));
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04'))->assertCreated();
    }

    public function test_an_idempotent_retry_returns_the_same_event_and_never_a_second_row(): void
    {
        $task = $this->task($this->user);
        $headers = ['Idempotency-Key' => 'tap-1'];

        $first = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot(), $headers)->assertCreated()->assertHeaderMissing('Idempotent-Replay');
        $retry = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot(), $headers)->assertOk()->assertHeader('Idempotent-Replay', 'true')
            ->assertJsonPath('data.id', $first->json('data.id'))->assertJsonPath('schedule.session_id', $first->json('data.id'));
        $this->assertSame($first->json('data'), $retry->json('data'));
        $this->assertSame(1, $this->taskSessions($task));
        // A different key is a new request and meets the rule; so does no key.
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04'), ['Idempotency-Key' => 'tap-2'])->assertStatus(409);
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04'))->assertStatus(409);
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot(), ['Idempotency-Key' => str_repeat('k', 101)])->assertUnprocessable()->assertJsonValidationErrors('idempotency_key');

        // POST /api/events honours it when a task is present.
        $other = $this->task($this->user);
        $body = ['title' => 'Work', 'task_id' => $other->id] + $this->slot('2027-02-05');
        $a = $this->postJson('/api/events', $body, $headers)->assertCreated();
        $b = $this->postJson('/api/events', $body, $headers)->assertOk()->assertHeader('Idempotent-Replay', 'true')->assertJsonPath('data.id', $a->json('data.id'));
        $this->assertSame(1, $this->taskSessions($other));
        $this->assertNull($b->json('schedule'));
    }

    public function test_an_idempotency_key_is_per_user_and_expires(): void
    {
        $task = $this->task($this->user);
        $headers = ['Idempotency-Key' => 'shared-key'];
        $first = $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot(), $headers)->assertCreated();

        $stranger = User::factory()->create();
        $theirs = $this->task($stranger);
        $this->actingAs($stranger)->postJson("/api/tasks/{$theirs->id}/schedule", $this->slot(), $headers)->assertCreated()->assertHeaderMissing('Idempotent-Replay');
        $this->assertNotSame($first->json('data.id'), CalendarEvent::where('task_id', $theirs->id)->value('id'));

        $this->actingAs($this->user);
        CalendarEvent::whereKey($first->json('data.id'))->delete();
        $this->travelTo(now()->addMinutes(11));
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('2027-02-04'), $headers)->assertCreated()->assertHeaderMissing('Idempotent-Replay');
    }

    public function test_other_users_tasks_are_not_found_and_their_sessions_are_not_counted(): void
    {
        $stranger = User::factory()->create();
        $theirs = $this->task($stranger);
        $this->makeSession($theirs, '2027-02-03 09:00', '2027-02-03 10:00', $stranger);
        $mine = $this->task($this->user);
        // A (hypothetical) stray event of another user linked to my task does not count either.
        $this->makeSession($mine, '2027-02-03 11:00', '2027-02-03 12:00', $stranger);

        $this->postJson("/api/tasks/{$theirs->id}/schedule", $this->slot())->assertNotFound();
        $this->putJson("/api/tasks/{$theirs->id}/schedule", $this->slot())->assertNotFound();
        $this->postJson('/api/events', ['title' => 'x', 'task_id' => $theirs->id] + $this->slot())->assertUnprocessable()->assertJsonValidationErrors('task_id');
        $this->postJson("/api/tasks/{$mine->id}/schedule", $this->slot())->assertCreated()->assertJsonPath('schedule.sessions', 1);
        $this->assertSame(1, CalendarEvent::where('user_id', $stranger->id)->where('task_id', $theirs->id)->count());
    }

    public function test_task_json_carries_the_earliest_active_session_without_n_plus_one(): void
    {
        $scheduled = $this->task($this->user);
        $plain = $this->task($this->user);
        $split = $this->task($this->user, true);
        $this->makeSession($scheduled, '2027-02-03 09:00', '2027-02-03 10:00');
        $later = $this->makeSession($split, '2027-02-05 09:00', '2027-02-05 10:00');
        $earlier = $this->makeSession($split, '2027-02-04 09:00', '2027-02-04 10:00');
        Task::factory()->count(5)->create(['user_id' => $this->user->id]);

        $queries = 0;
        DB::listen(function ($q) use (&$queries) {
            $queries += str_contains($q->sql, 'calendar_events') ? 1 : 0;
        });
        $rows = collect($this->getJson('/api/tasks')->assertOk()->json('data'))->keyBy('id');

        $this->assertSame(1, $queries, 'one batch query for the schedules of the page');
        $this->assertNull($rows[$plain->id]['schedule']);
        $this->assertSame(['session_id' => $earlier->id, 'starts_at' => '2027-02-04T09:00:00Z', 'ends_at' => '2027-02-04T10:00:00Z', 'sessions' => 2, 'split' => true], $rows[$split->id]['schedule']);
        $this->assertNotSame($later->id, $rows[$split->id]['schedule']['session_id']);
        $this->getJson("/api/tasks/{$scheduled->id}")->assertOk()->assertJsonPath('data.schedule.sessions', 1)->assertJsonPath('data.schedule.split', false)->assertJsonPath('data.scheduled_start', null);
        $this->patchJson("/api/tasks/{$scheduled->id}", ['title' => 'Renamed'])->assertOk()->assertJsonPath('data.schedule.session_id', CalendarEvent::where('task_id', $scheduled->id)->value('id'));
    }

    /**
     * @return iterable<string, array{string, string, string, string}> local start/end with an explicit offset, expected UTC start/end
     */
    public static function boundaries(): iterable
    {
        yield 'spring forward: last minute before the gap' => ['2026-03-29T01:30:00+01:00', '2026-03-29T01:59:00+01:00', '2026-03-29T00:30:00Z', '2026-03-29T00:59:00Z'];
        yield 'spring forward: 02:30 does not exist, 03:30 CEST is 01:30Z' => ['2026-03-29T03:30:00+02:00', '2026-03-29T04:30:00+02:00', '2026-03-29T01:30:00Z', '2026-03-29T02:30:00Z'];
        yield 'spring forward: block across the gap is 1h of real time' => ['2026-03-29T01:30:00+01:00', '2026-03-29T03:30:00+02:00', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z'];
        yield 'fall back: first 02:30 (CEST)' => ['2026-10-25T02:30:00+02:00', '2026-10-25T03:00:00+02:00', '2026-10-25T00:30:00Z', '2026-10-25T01:00:00Z'];
        yield 'fall back: second 02:30 (CET)' => ['2026-10-25T02:30:00+01:00', '2026-10-25T03:00:00+01:00', '2026-10-25T01:30:00Z', '2026-10-25T02:00:00Z'];
        yield 'around midnight, winter' => ['2026-11-11T23:30:00+01:00', '2026-11-12T00:30:00+01:00', '2026-11-11T22:30:00Z', '2026-11-11T23:30:00Z'];
        yield 'around midnight, summer' => ['2026-07-01T23:30:00+02:00', '2026-07-02T00:30:00+02:00', '2026-07-01T21:30:00Z', '2026-07-01T22:30:00Z'];
    }

    #[DataProvider('boundaries')]
    public function test_schedules_round_trip_as_utc_instants_around_dst_and_midnight(string $localStart, string $localEnd, string $utcStart, string $utcEnd): void
    {
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->travelTo(CarbonImmutable::parse('2026-02-20 12:00', 'UTC'));
        $task = $this->task($this->user);

        $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => $localStart, 'ends_at' => $localEnd])->assertCreated()
            ->assertJsonPath('schedule.starts_at', $utcStart)->assertJsonPath('schedule.ends_at', $utcEnd);

        $stored = CalendarEvent::where('task_id', $task->id)->firstOrFail();
        $this->assertSame(CarbonImmutable::parse($utcStart)->getTimestamp(), $stored->starts_at->getTimestamp());
        $this->assertSame(CarbonImmutable::parse($utcEnd)->getTimestamp(), $stored->ends_at->getTimestamp());
        $listed = $this->getJson('/api/tasks')->json('data.0.schedule');
        $this->assertSame($utcStart, $listed['starts_at']);
        $this->assertSame(CarbonImmutable::parse($localStart)->getTimestamp(), CarbonImmutable::parse($listed['starts_at'])->getTimestamp(), 'the instant is the one the client sent');
        $this->assertSame(CarbonImmutable::parse($localStart)->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'), CarbonImmutable::parse($listed['starts_at'])->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));
    }

    public function test_local_wall_time_in_the_dst_gap_and_overlap_resolves_deterministically(): void
    {
        // Resolution of a wall time that does not exist (the gap) or exists twice (the overlap) is PHP's: the gap moves forward to 03:30 CEST, the
        // overlap resolves to the later, standard-time occurrence (02:30 CET). The API itself only trusts instants: a zone-less string is read as UTC.
        $this->travelTo(CarbonImmutable::parse('2026-02-20 12:00', 'UTC'));
        foreach ([['2026-03-29 02:30', '2026-03-29T01:30:00Z'], ['2026-10-25 02:30', '2026-10-25T01:30:00Z']] as [$local, $utc]) {
            $task = $this->task($this->user);
            $start = CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
            $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => $start->toIso8601String(), 'ends_at' => $start->addMinutes(30)->toIso8601String()])->assertCreated()->assertJsonPath('schedule.starts_at', $utc);
        }
        $task = $this->task($this->user);
        $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-10-25 02:30:00', 'ends_at' => '2026-10-25 03:00:00'])->assertCreated()->assertJsonPath('schedule.starts_at', '2026-10-25T02:30:00Z');
    }

    public function test_the_duplicates_report_is_read_only_and_lists_only_ordinary_tasks_with_several_active_sessions(): void
    {
        $double = $this->task($this->user, false, ['title' => 'Double tapped']);
        $a = $this->makeSession($double, '2027-02-03 09:00', '2027-02-03 10:00');
        $b = $this->makeSession($double, '2027-02-04 09:00', '2027-02-04 10:00');
        $a->forceFill(['created_at' => '2027-02-01 07:00:00'])->saveQuietly();
        $b->forceFill(['created_at' => '2027-02-01 07:00:03'])->saveQuietly();
        $single = $this->task($this->user);
        $this->makeSession($single, '2027-02-03 11:00', '2027-02-03 12:00');
        $split = $this->task($this->user, true);
        $this->makeSession($split, '2027-02-03 13:00', '2027-02-03 14:00');
        $this->makeSession($split, '2027-02-04 13:00', '2027-02-04 14:00');
        $history = $this->task($this->user);
        $this->makeSession($history, '2027-01-20 09:00', '2027-01-20 10:00');
        $this->makeSession($history, '2027-02-04 15:00', '2027-02-04 16:00');
        $deliberate = $this->task($this->user);
        $c = $this->makeSession($deliberate, '2027-02-05 09:00', '2027-02-05 10:00');
        $d = $this->makeSession($deliberate, '2027-02-06 09:00', '2027-02-06 10:00');
        $c->forceFill(['created_at' => '2027-01-30 09:00:00'])->saveQuietly();
        $d->forceFill(['created_at' => '2027-02-01 07:30:00'])->saveQuietly();

        $snapshot = fn () => [CalendarEvent::orderBy('id')->get()->toArray(), Task::orderBy('id')->get()->toArray()];
        $before = $snapshot();
        $this->assertSame(0, Artisan::call('lifeos:schedule:duplicates', ['--json' => true]));
        $report = json_decode(Artisan::output(), true);
        $text = (function () {
            Artisan::call('lifeos:schedule:duplicates');

            return Artisan::output();
        })();

        $this->assertSame($before, $snapshot(), 'the report changes nothing');
        $this->assertSame(['affected_tasks' => 2, 'surplus_sessions' => 2], $report['totals']);
        $rows = collect($report['tasks'])->keyBy('task_id');
        $this->assertEqualsCanonicalizing([$double->id, $deliberate->id], $rows->keys()->all());
        $this->assertSame(2, $rows[$double->id]['sessions']);
        $this->assertSame([$a->id, $b->id], collect($rows[$double->id]['events'])->pluck('id')->all());
        $this->assertSame([null, 3], collect($rows[$double->id]['events'])->pluck('created_gap_seconds')->all());
        $this->assertSame($this->user->id, $rows[$double->id]['user_id']);
        $this->assertStringContainsString('double tap', $rows[$double->id]['suggestion']);
        $this->assertStringContainsString('deliberate', $rows[$deliberate->id]['suggestion']);
        $this->assertStringContainsString('never auto-delete', $rows[$deliberate->id]['suggestion']);
        $this->assertStringContainsString('Affected tasks: 2. Surplus sessions: 2. Nothing was changed.', $text);
        $this->assertSame($before, $snapshot());
    }

    public function test_the_migration_adds_the_flag_defaulting_to_false_and_the_session_index(): void
    {
        $this->assertTrue(Schema::hasColumn('tasks', 'split_sessions'));
        $this->assertFalse($this->task($this->user)->fresh()->split_sessions);
        $this->assertTrue(Schema::hasIndex('calendar_events', 'calendar_events_user_task_ends_index'));
    }
}
