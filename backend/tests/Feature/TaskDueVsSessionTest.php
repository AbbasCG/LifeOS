<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\ConflictService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Contract: a task's deadline (tasks.due_at, edited in the task dialog) and its calendar session (a non-recurring CalendarEvent with task_id,
 * moved with PUT /api/tasks/{id}/schedule) are independent. Editing the deadline never touches the session, and moving the session never
 * touches the deadline.
 *
 * Wire formats (exact): task JSON `due_at` is "2026-11-12T09:00:00.000000Z" (microseconds, Z); `schedule.starts_at` / `ends_at` and the
 * 409 `session` payload are "2026-11-20T09:00:00Z" (no microseconds, Z); an event resource `starts_at` is "2026-11-20T09:00:00.000000Z".
 */
class TaskDueVsSessionTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2026-01-15 08:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
    }

    private function task(array $attributes = []): Task
    {
        return Task::factory()->create(array_merge(['user_id' => $this->user->id, 'due_at' => '2026-02-10 12:00:00', 'status' => 'todo'], $attributes));
    }

    private function plannedSession(Task $task, string $start = '2026-02-03T09:00:00Z', string $end = '2026-02-03T10:00:00Z', string $kind = 'flexible'): CalendarEvent
    {
        return CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => $task->title, 'kind' => $kind, 'starts_at' => $start, 'ends_at' => $end]);
    }

    private function utc(?object $at): ?string
    {
        return $at ? CarbonImmutable::instance($at)->utc()->format('Y-m-d\TH:i:s\Z') : null;
    }

    /** @return array<string, array{string, string}> */
    public static function dueInstants(): array
    {
        return [
            'with Z' => ['2026-02-12T09:30:00Z', '2026-02-12T09:30:00Z'],
            'with offset +00:00' => ['2026-02-12T09:30:00+00:00', '2026-02-12T09:30:00Z'],
            'Amsterdam winter +01:00' => ['2026-02-12T10:30:00+01:00', '2026-02-12T09:30:00Z'],
            'Amsterdam summer +02:00' => ['2026-07-12T10:30:00+02:00', '2026-07-12T08:30:00Z'],
            'local midnight +01:00' => ['2026-02-12T00:00:00+01:00', '2026-02-11T23:00:00Z'],
            'local 23:59 +01:00' => ['2026-02-12T23:59:00+01:00', '2026-02-12T22:59:00Z'],
            'local midnight +02:00' => ['2026-07-12T00:00:00+02:00', '2026-07-11T22:00:00Z'],
            'local 23:59 +02:00' => ['2026-07-12T23:59:00+02:00', '2026-07-12T21:59:00Z'],
            // 2026-03-29: clocks go 02:00 -> 03:00 (CET -> CEST). 02:30 does not exist; a client that still used +01:00 sends the instant 01:30Z.
            'DST gap, old offset' => ['2026-03-29T02:30:00+01:00', '2026-03-29T01:30:00Z'],
            'DST gap, new offset' => ['2026-03-29T03:30:00+02:00', '2026-03-29T01:30:00Z'],
            // 2026-10-25: clocks go 03:00 -> 02:00 (CEST -> CET). 02:30 happens twice and the offset tells them apart.
            'DST overlap, first (+02:00)' => ['2026-10-25T02:30:00+02:00', '2026-10-25T00:30:00Z'],
            'DST overlap, second (+01:00)' => ['2026-10-25T02:30:00+01:00', '2026-10-25T01:30:00Z'],
            'DST day local midnight' => ['2026-10-25T00:00:00+02:00', '2026-10-24T22:00:00Z'],
            'DST day local 23:59' => ['2026-10-25T23:59:00+01:00', '2026-10-25T22:59:00Z'],
        ];
    }

    #[DataProvider('dueInstants')]
    public function test_patching_due_at_stores_exactly_the_instant_sent_and_leaves_the_session_alone(string $sent, string $storedUtc): void
    {
        $task = $this->task();
        $session = $this->plannedSession($task);
        $window = [$task->scheduled_start, $task->scheduled_end];
        $eventsBefore = CalendarEvent::count();

        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => $sent])->assertOk()
            ->assertJsonPath('data.due_at', CarbonImmutable::parse($storedUtc)->format('Y-m-d\TH:i:s.u\Z'))
            ->assertJsonPath('data.schedule.session_id', $session->id)
            ->assertJsonPath('data.schedule.starts_at', '2026-02-03T09:00:00Z')
            ->assertJsonPath('data.schedule.ends_at', '2026-02-03T10:00:00Z')
            ->assertJsonPath('data.schedule.sessions', 1);

        $this->assertSame($storedUtc, $this->utc($task->fresh()->due_at));
        $this->assertSame($eventsBefore, CalendarEvent::count());
        $session = $session->fresh();
        $this->assertSame(['2026-02-03T09:00:00Z', '2026-02-03T10:00:00Z'], [$this->utc($session->starts_at), $this->utc($session->ends_at)]);
        $this->assertEquals($window, [$task->fresh()->scheduled_start, $task->fresh()->scheduled_end]);
    }

    public function test_exact_json_of_a_patched_task_and_its_schedule(): void
    {
        $task = $this->task();
        $session = $this->plannedSession($task);

        $json = $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-12T10:30:00+01:00'])->assertOk()->json('data');

        $this->assertSame('2026-02-12T09:30:00.000000Z', $json['due_at']);
        $this->assertSame(['session_id' => $session->id, 'starts_at' => '2026-02-03T09:00:00Z', 'ends_at' => '2026-02-03T10:00:00Z', 'sessions' => 1, 'split' => false], $json['schedule']);
        // The same row read back (GET) carries identical strings: the dialog can compare them with what it sent.
        $this->getJson("/api/tasks/{$task->id}")->assertOk()->assertJsonPath('data.due_at', '2026-02-12T09:30:00.000000Z')->assertJsonPath('data.schedule', $json['schedule']);
        // And the session as an event resource: microseconds, Z.
        $this->getJson('/api/events?from=2026-02-03T00:00:00Z&to=2026-02-04T00:00:00Z')->assertOk()->assertJsonPath('data.0.starts_at', '2026-02-03T09:00:00.000000Z');
    }

    public function test_due_at_can_be_cleared_with_null_and_the_session_stays(): void
    {
        $task = $this->task();
        $session = $this->plannedSession($task);

        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => null])->assertOk()
            ->assertJsonPath('data.due_at', null)->assertJsonPath('data.schedule.session_id', $session->id);
        $this->assertNull($task->fresh()->due_at);
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
    }

    public function test_a_deadline_before_the_session_end_is_accepted(): void
    {
        // The UI warns about it; the server has no rule against it (only plan ACCEPTANCE refuses a generated block that ends after due_at).
        $task = $this->task();
        $this->plannedSession($task, '2026-02-03T09:00:00Z', '2026-02-03T10:00:00Z');

        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-03T09:30:00Z'])->assertOk()
            ->assertJsonPath('data.due_at', '2026-02-03T09:30:00.000000Z');
        // ... and a deadline already in the past too.
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => '2025-12-01T09:30:00Z'])->assertOk();
        // ... and moving the session past the deadline.
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-03-01T09:00:00Z', 'ends_at' => '2026-03-01T10:00:00Z'])->assertOk();
    }

    public function test_postponed_count_follows_the_deadline_only_never_a_session_move(): void
    {
        $task = $this->task(['due_at' => '2026-02-10 12:00:00']);
        $session = $this->plannedSession($task);

        // Session moved days later: not a postponement.
        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-20T09:00:00Z', 'ends_at' => '2026-02-20T10:00:00Z'])->assertOk();
        $this->assertSame(0, (int) $task->fresh()->postponed_count);
        // Deadline +30 minutes: within the hour, not a postponement.
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-10T12:30:00Z'])->assertOk();
        $this->assertSame(0, (int) $task->fresh()->postponed_count);
        // Deadline a day later: postponement.
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-11T12:30:00Z'])->assertOk();
        $this->assertSame(1, (int) $task->fresh()->postponed_count);
        // Earlier, and clearing: not postponements.
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-05T12:30:00Z'])->assertOk();
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => null])->assertOk();
        $this->assertSame(1, (int) $task->fresh()->postponed_count);
        $this->assertSame($session->id, CalendarEvent::where('task_id', $task->id)->value('id'));
    }

    public function test_date_only_due_at_is_read_as_midnight_utc_of_that_day(): void
    {
        // Documented behaviour, not an endorsement: there is no date-only column. "2026-11-12" passes the `date` rule and Carbon reads it in the
        // app timezone (UTC), so it is the instant 2026-11-12T00:00:00Z (01:00 in Amsterdam). The UI always sends a full ISO instant.
        $task = $this->task();

        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-11-12'])->assertOk()
            ->assertJsonPath('data.due_at', '2026-11-12T00:00:00.000000Z');
        $this->assertSame('2026-11-12T00:00:00Z', $this->utc($task->fresh()->due_at));
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => 'not a date'])->assertUnprocessable()->assertJsonValidationErrors('due_at');
    }

    public function test_moving_the_session_keeps_the_same_row_and_never_creates_one(): void
    {
        $task = $this->task();
        $session = $this->plannedSession($task);
        $due = $task->due_at;

        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-04T10:15:00+01:00', 'ends_at' => '2026-02-04T11:15:00+01:00'])->assertOk()
            ->assertJsonPath('data.id', $session->id)
            ->assertJsonPath('data.starts_at', '2026-02-04T09:15:00.000000Z')
            ->assertJsonPath('schedule.session_id', $session->id)
            ->assertJsonPath('schedule.starts_at', '2026-02-04T09:15:00Z')
            ->assertJsonPath('schedule.ends_at', '2026-02-04T10:15:00Z')
            ->assertJsonPath('schedule.sessions', 1);

        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
        $this->assertEquals($due, $task->fresh()->due_at);
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_put_without_a_session_does_not_create_one(): void
    {
        $task = $this->task();

        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-04T09:00:00Z', 'ends_at' => '2026-02-04T10:00:00Z'])
            ->assertStatus(404)->assertJsonPath('code', 'task_not_scheduled');
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_a_second_post_schedule_is_refused_with_409_and_the_existing_session(): void
    {
        $task = $this->task();
        $payload = ['starts_at' => '2026-02-05T09:00:00Z', 'ends_at' => '2026-02-05T10:00:00Z'];

        $first = $this->actingAs($this->user)->postJson("/api/tasks/{$task->id}/schedule", $payload)->assertCreated()->json('data.id');
        $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-06T09:00:00Z', 'ends_at' => '2026-02-06T10:00:00Z'])
            ->assertStatus(409)->assertJsonPath('code', 'task_already_scheduled')
            ->assertJsonPath('session', ['id' => $first, 'starts_at' => '2026-02-05T09:00:00Z', 'ends_at' => '2026-02-05T10:00:00Z', 'task_id' => $task->id]);
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
        // Editing the deadline in between changes nothing about that.
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-20T09:00:00Z'])->assertOk();
        $this->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-07T09:00:00Z', 'ends_at' => '2026-02-07T10:00:00Z'])->assertStatus(409);
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
    }

    public function test_session_times_around_daylight_saving_are_stored_as_the_instants_sent(): void
    {
        $task = $this->task();
        $this->plannedSession($task);
        $this->actingAs($this->user);

        // Gap day 2026-03-29: 03:30 CEST is 01:30Z; the UI would never send the nonexistent 02:30, a client that does (+01:00) gets 01:30Z too.
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-03-29T03:30:00+02:00', 'ends_at' => '2026-03-29T04:30:00+02:00'])->assertOk()
            ->assertJsonPath('schedule.starts_at', '2026-03-29T01:30:00Z')->assertJsonPath('schedule.ends_at', '2026-03-29T02:30:00Z');
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-03-29T02:30:00+01:00', 'ends_at' => '2026-03-29T03:30:00+01:00'])->assertOk()
            ->assertJsonPath('schedule.starts_at', '2026-03-29T01:30:00Z')->assertJsonPath('schedule.ends_at', '2026-03-29T02:30:00Z');
        // Overlap day 2026-10-25: both 02:30 are distinct instants.
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-10-25T02:30:00+02:00', 'ends_at' => '2026-10-25T03:30:00+02:00'])->assertOk()
            ->assertJsonPath('schedule.starts_at', '2026-10-25T00:30:00Z')->assertJsonPath('schedule.ends_at', '2026-10-25T01:30:00Z');
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-10-25T02:30:00+01:00', 'ends_at' => '2026-10-25T03:30:00+01:00'])->assertOk()
            ->assertJsonPath('schedule.starts_at', '2026-10-25T01:30:00Z')->assertJsonPath('schedule.ends_at', '2026-10-25T02:30:00Z');
        // Midnight and 23:59 local on the 25-hour day (23:30 local is 22:30Z, 00:00 local is 22:00Z the day before).
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-10-25T00:00:00+02:00', 'ends_at' => '2026-10-25T23:59:00+01:00'])->assertOk()
            ->assertJsonPath('schedule.starts_at', '2026-10-24T22:00:00Z')->assertJsonPath('schedule.ends_at', '2026-10-25T22:59:00Z');
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
    }

    public function test_other_users_tasks_are_invisible_and_unchanged(): void
    {
        $other = User::factory()->create();
        $theirs = Task::factory()->create(['user_id' => $other->id, 'due_at' => '2026-02-10 12:00:00']);
        $theirSession = CalendarEvent::create(['user_id' => $other->id, 'task_id' => $theirs->id, 'title' => 'x', 'kind' => 'flexible', 'starts_at' => '2026-02-03T09:00:00Z', 'ends_at' => '2026-02-03T10:00:00Z']);
        $times = ['starts_at' => '2026-02-08T09:00:00Z', 'ends_at' => '2026-02-08T10:00:00Z'];

        $this->actingAs($this->user);
        $this->patchJson("/api/tasks/{$theirs->id}", ['due_at' => '2026-03-01T09:00:00Z'])->assertNotFound();
        $this->putJson("/api/tasks/{$theirs->id}/schedule", $times)->assertNotFound();
        $this->postJson("/api/tasks/{$theirs->id}/schedule", $times)->assertNotFound();

        $this->assertSame('2026-02-10T12:00:00Z', $this->utc($theirs->fresh()->due_at));
        $this->assertSame(1, CalendarEvent::where('task_id', $theirs->id)->count());
        $this->assertSame('2026-02-03T09:00:00Z', $this->utc($theirSession->fresh()->starts_at));
    }

    public function test_moving_a_session_onto_another_event_is_refused_on_starts_at(): void
    {
        $task = $this->task();
        $session = $this->plannedSession($task);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Standup', 'kind' => 'flexible', 'starts_at' => '2026-02-04T09:00:00Z', 'ends_at' => '2026-02-04T09:30:00Z']);

        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-04T09:15:00Z', 'ends_at' => '2026-02-04T10:15:00Z'])
            ->assertUnprocessable()->assertJsonValidationErrors('starts_at');
        $this->assertSame('2026-02-03T09:00:00Z', $this->utc($session->fresh()->starts_at));
    }

    public function test_moving_a_session_onto_a_fixed_event_is_refused_on_starts_at_and_a_fixed_session_needs_confirmation(): void
    {
        $task = $this->task();
        $session = $this->plannedSession($task);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Exam', 'kind' => 'fixed', 'starts_at' => '2026-02-04T09:00:00Z', 'ends_at' => '2026-02-04T10:00:00Z']);
        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-04T09:30:00Z', 'ends_at' => '2026-02-04T10:30:00Z'])
            ->assertUnprocessable()->assertJsonValidationErrors('starts_at');

        // A session that is itself a fixed commitment: 422 `fixed` until confirm_fixed is sent.
        $session->update(['kind' => 'fixed']);
        $free = ['starts_at' => '2026-02-06T09:00:00Z', 'ends_at' => '2026-02-06T10:00:00Z'];
        $this->putJson("/api/tasks/{$task->id}/schedule", $free)->assertUnprocessable()->assertJsonValidationErrors('fixed');
        $this->assertSame('2026-02-03T09:00:00Z', $this->utc($session->fresh()->starts_at));
        $this->putJson("/api/tasks/{$task->id}/schedule", $free + ['confirm_fixed' => true])->assertOk()->assertJsonPath('schedule.starts_at', '2026-02-06T09:00:00Z');
    }

    public function test_planned_window_follows_a_session_move_and_a_session_delete(): void
    {
        // tasks.scheduled_start/scheduled_end are written by plan acceptance and read by ConflictService (busy_task). Without the sync in
        // CalendarEvent::booted() they went stale: a conflict the user had just fixed by moving the session was still reported.
        $task = $this->task(['scheduled_start' => '2026-02-03 09:00:00', 'scheduled_end' => '2026-02-03 10:00:00']);
        $session = $this->plannedSession($task);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Dentist', 'kind' => 'fixed', 'starts_at' => '2026-02-03T09:30:00Z', 'ends_at' => '2026-02-03T10:30:00Z']);
        $from = CarbonImmutable::parse('2026-02-01', 'UTC');
        $busy = fn () => collect(app(ConflictService::class)->detect($this->user, $from, $from->addDays(14)))->where('type', 'busy_task')->count();
        $this->assertGreaterThan(0, $busy(), 'the overlapping session is a conflict');

        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-05T09:00:00Z', 'ends_at' => '2026-02-05T10:00:00Z'])->assertOk();
        $fresh = $task->fresh();
        $this->assertSame(['2026-02-05T09:00:00Z', '2026-02-05T10:00:00Z'], [$this->utc($fresh->scheduled_start), $this->utc($fresh->scheduled_end)]);
        $this->assertSame(0, $busy(), 'the fixed conflict is gone once the session moved');
        $this->assertSame('2026-02-10T12:00:00Z', $this->utc($fresh->due_at));

        $this->deleteJson("/api/events/{$session->id}")->assertOk();
        $fresh = $task->fresh();
        $this->assertNull($fresh->scheduled_start);
        $this->assertNull($fresh->scheduled_end);
    }

    public function test_a_task_without_a_planned_window_never_gets_one_from_a_plain_schedule(): void
    {
        $task = $this->task();

        $this->actingAs($this->user)->postJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-05T09:00:00Z', 'ends_at' => '2026-02-05T10:00:00Z'])->assertCreated();
        $this->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-06T09:00:00Z', 'ends_at' => '2026-02-06T10:00:00Z'])->assertOk();
        $this->assertNull($task->fresh()->scheduled_start);
        $this->assertNull($task->fresh()->scheduled_end);
    }

    public function test_due_filters_use_the_users_local_day_not_a_fixed_hour(): void
    {
        // 'today'/'week' are bounded by the user's local midnight; no 23:00 / 23:59 convention is applied to due_at on the server.
        $this->travelTo(CarbonImmutable::parse('2026-02-10 12:00', 'UTC')); // 13:00 Amsterdam
        $late = $this->task(['title' => 'Late tonight', 'due_at' => '2026-02-10 22:59:00']); // 23:59 local
        $midnight = $this->task(['title' => 'Local midnight', 'due_at' => '2026-02-10 23:00:00']); // 00:00 local, next day
        $this->task(['title' => 'Tomorrow', 'due_at' => '2026-02-11 10:00:00']);

        $today = $this->actingAs($this->user)->getJson('/api/tasks?due=today')->assertOk()->json('data.*.id');
        $this->assertContains($late->id, $today);
        $this->assertNotContains($midnight->id, $today, '00:00 local belongs to the next local day');
        $this->assertContains($midnight->id, $this->getJson('/api/tasks?due=week')->json('data.*.id'));
    }

    public function test_remind_at_keeps_the_instant_sent_and_clears_with_null(): void
    {
        $task = $this->task();

        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['remind_at' => '2026-02-09T08:00:00+01:00'])->assertOk()
            ->assertJsonPath('data.remind_at', '2026-02-09T07:00:00.000000Z');
        $this->assertSame('2026-02-09T07:00:00Z', $this->utc($task->fresh()->remind_at));
        $this->patchJson("/api/tasks/{$task->id}", ['remind_at' => null])->assertOk()->assertJsonPath('data.remind_at', null);
        $this->patchJson("/api/tasks/{$task->id}", ['due_at' => ''])->assertOk()->assertJsonPath('data.due_at', null);
        $this->assertNull($task->fresh()->due_at);
    }

    public function test_new_projects_and_goals_keep_the_offset_of_due_at(): void
    {
        $this->actingAs($this->user);

        $project = $this->postJson('/api/projects', ['title' => 'P', 'due_at' => '2026-07-12T10:30:00+02:00'])->assertCreated()->assertJsonPath('data.due_at', '2026-07-12T08:30:00.000000Z')->json('data.id');
        $goal = $this->postJson('/api/goals', ['title' => 'G', 'due_at' => '2026-07-12T10:30:00+02:00'])->assertCreated()->assertJsonPath('data.due_at', '2026-07-12T08:30:00.000000Z')->json('data.id');
        $this->patchJson("/api/projects/{$project}", ['due_at' => null])->assertOk()->assertJsonPath('data.due_at', null);
        $this->patchJson("/api/goals/{$goal}", ['due_at' => '2026-07-12T10:30:00+01:00'])->assertOk()->assertJsonPath('data.due_at', '2026-07-12T09:30:00.000000Z');
        $this->postJson('/api/tasks', ['title' => 'T'])->assertCreated()->assertJsonPath('data.due_at', null);
    }

    public function test_accepting_a_multi_block_plan_sets_the_window_to_earliest_start_and_latest_end(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-01-04 08:00', 'UTC'));
        $user = User::factory()->create();
        $task = Task::create(['user_id' => $user->id, 'title' => 'Study', 'estimated_minutes' => 90, 'due_at' => '2027-01-04T18:00:00Z']);
        CalendarEvent::create(['user_id' => $user->id, 'title' => 'Fixed', 'starts_at' => '2027-01-04T09:00:00Z', 'ends_at' => '2027-01-04T10:00:00Z']);
        $this->actingAs($user);
        $plan = $this->postJson('/api/plans', ['date' => '2027-01-04', 'days' => 1])->assertCreated()->json();
        $this->postJson('/api/plans/'.$plan['id'].'/accept')->assertOk();

        $sessions = CalendarEvent::where('task_id', $task->id)->orderBy('starts_at')->get();
        $this->assertCount(2, $sessions);
        $fresh = $task->fresh();
        $this->assertSame($this->utc($sessions->first()->starts_at), $this->utc($fresh->scheduled_start));
        $this->assertSame($this->utc($sessions->last()->ends_at), $this->utc($fresh->scheduled_end));
    }

    public function test_today_deadlines_are_half_open_at_local_midnight_and_day_plus_seven(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-02-10 12:00', 'UTC')); // 13:00 Amsterdam; local day = 2026-02-09T23:00Z .. 2026-02-10T23:00Z
        $nextMidnight = $this->task(['title' => 'Next midnight', 'due_at' => '2026-02-10 23:00:00']);
        $dayPlus7 = $this->task(['title' => 'Day plus seven', 'due_at' => '2026-02-16 23:00:00']);
        $justBefore = $this->task(['title' => 'Just before', 'due_at' => '2026-02-16 22:59:00']);

        $deadlines = collect($this->actingAs($this->user)->getJson('/api/today')->assertOk()->json('deadlines'))->where('type', 'task')->keyBy('id');
        $this->assertSame('tomorrow', $deadlines[$nextMidnight->id]['bucket']);
        $this->assertArrayHasKey($justBefore->id, $deadlines->all());
        $this->assertArrayNotHasKey($dayPlus7->id, $deadlines->all());
    }
}
