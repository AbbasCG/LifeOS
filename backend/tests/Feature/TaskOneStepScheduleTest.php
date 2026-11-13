<?php

namespace Tests\Feature;

use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\ExternalEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * One-step save: POST /api/tasks and PATCH /api/tasks/{id} accept an optional `schedule` that books, moves or removes the task's session in the
 * SAME transaction as the task fields. A refusal saves nothing; no `schedule` key leaves sessions alone.
 *
 * "Now" is Monday 2027-02-01 08:00 UTC; the user has no settings (UTC, 09:00-17:00 Monday to Friday) except in the DST tests.
 */
class TaskOneStepScheduleTest extends TestCase
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

    private function at(string $time, string $day = '2027-02-03'): string
    {
        return "{$day}T{$time}:00Z";
    }

    private function task(array $attributes = [], ?User $owner = null): Task
    {
        return Task::factory()->create(['user_id' => ($owner ?? $this->user)->id] + $attributes + ['title' => 'Write report', 'estimated_minutes' => 30, 'status' => 'todo', 'priority' => 'medium', 'due_at' => '2027-02-10 12:00:00']);
    }

    private function booked(Task $task, string $from, string $to, string $day = '2027-02-03'): CalendarEvent
    {
        return CalendarEvent::factory()->create(['user_id' => $task->user_id, 'task_id' => $task->id, 'title' => $task->title, 'kind' => 'flexible', 'starts_at' => "{$day} {$from}:00", 'ends_at' => "{$day} {$to}:00"]);
    }

    private function busy(string $from, string $to, string $title = 'Dentist', ?User $owner = null): CalendarEvent
    {
        return CalendarEvent::factory()->create(['user_id' => ($owner ?? $this->user)->id, 'title' => $title, 'kind' => 'fixed', 'starts_at' => "2027-02-03 {$from}:00", 'ends_at' => "2027-02-03 {$to}:00"]);
    }

    /** @return array<string, mixed> the task columns a refusal must leave untouched */
    private function snapshot(Task $task): array
    {
        return array_intersect_key(Task::findOrFail($task->id)->getAttributes(), array_flip(['title', 'priority', 'estimated_minutes', 'due_at', 'due_all_day', 'status', 'updated_at']));
    }

    private function dump(string $name, TestResponse $response, array $request): void
    {
        if ($dir = getenv('ONE_STEP_DUMP')) {
            file_put_contents("{$dir}/{$name}.json", json_encode(['status' => $response->getStatusCode(), 'request' => $request, 'response' => $response->json()], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        }
    }

    public function test_a_new_task_and_its_session_are_created_in_one_request(): void
    {
        $body = ['title' => 'Plan the launch', 'priority' => 'high', 'estimated_minutes' => 45, 'schedule' => ['starts_at' => $this->at('09:00')]];
        $response = $this->postJson('/api/tasks', $body);
        $this->dump('create', $response, $body);

        $response->assertCreated()->assertJsonPath('data.title', 'Plan the launch')
            ->assertJsonPath('data.schedule.starts_at', $this->at('09:00'))->assertJsonPath('data.schedule.ends_at', $this->at('09:45'))
            ->assertJsonPath('data.schedule.sessions', 1)->assertJsonPath('data.schedule.split', false);
        $task = Task::where('title', 'Plan the launch')->sole();
        $event = CalendarEvent::where('task_id', $task->id)->sole();
        $response->assertJsonPath('data.schedule.session_id', $event->id);
        $this->assertSame('Plan the launch', $event->title);
        $this->assertSame('flexible', $event->kind);
        $this->assertNull($task->due_at, 'a schedule never creates a due date');
    }

    public function test_the_end_comes_from_the_estimate_of_the_same_request(): void
    {
        $this->postJson('/api/tasks', ['title' => 'Short', 'estimated_minutes' => 15, 'schedule' => ['starts_at' => $this->at('09:00')]])
            ->assertCreated()->assertJsonPath('data.schedule.ends_at', $this->at('09:15'));

        $task = $this->task(['estimated_minutes' => 30]);
        $this->booked($task, '11:00', '11:30');
        $this->patchJson("/api/tasks/{$task->id}", ['estimated_minutes' => 90, 'schedule' => ['starts_at' => $this->at('11:00')]])
            ->assertOk()->assertJsonPath('data.schedule.ends_at', $this->at('12:30'));
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
    }

    public function test_without_an_estimate_in_the_request_the_stored_one_is_used(): void
    {
        $task = $this->task(['estimated_minutes' => 20]);
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('14:00')]])->assertOk()->assertJsonPath('data.schedule.ends_at', $this->at('14:20'));
    }

    public function test_an_explicit_end_is_used_as_sent(): void
    {
        $task = $this->task();
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('10:00'), 'ends_at' => $this->at('12:00')]])->assertOk()->assertJsonPath('data.schedule.ends_at', $this->at('12:00'));
    }

    public function test_update_moves_the_existing_session_and_never_copies_it(): void
    {
        $task = $this->task();
        $event = $this->booked($task, '09:00', '09:30');
        $body = ['title' => 'Write the long report', 'schedule' => ['starts_at' => $this->at('13:00')]];
        $response = $this->patchJson("/api/tasks/{$task->id}", $body);
        $this->dump('update', $response, $body);

        $response->assertOk()->assertJsonPath('data.title', 'Write the long report')->assertJsonPath('data.schedule.session_id', $event->id)
            ->assertJsonPath('data.schedule.starts_at', $this->at('13:00'))->assertJsonPath('data.schedule.ends_at', $this->at('13:30'))->assertJsonPath('data.schedule.sessions', 1);
        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count());
        $this->assertEquals($this->at('13:00'), CarbonImmutable::parse(CalendarEvent::findOrFail($event->id)->starts_at)->format('Y-m-d\TH:i:s\Z'));
    }

    public function test_changing_only_the_duration_moves_the_same_session(): void
    {
        $task = $this->task();
        $event = $this->booked($task, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['estimated_minutes' => 60, 'schedule' => ['starts_at' => $this->at('09:00')]])
            ->assertOk()->assertJsonPath('data.schedule.session_id', $event->id)->assertJsonPath('data.schedule.ends_at', $this->at('10:00'));
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_an_adjacent_booking_is_allowed_and_a_15_minute_overlap_is_refused_with_the_conflict_object(): void
    {
        $this->busy('09:00', '09:30');
        $this->postJson('/api/tasks', ['title' => 'Right after', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('09:30')]])->assertCreated();

        $body = ['title' => 'Too early', 'priority' => 'urgent', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('09:15')]];
        $response = $this->postJson('/api/tasks', $body);
        $this->dump('conflict', $response, $body);

        $response->assertUnprocessable()->assertJsonStructure(['message', 'errors' => ['starts_at'], 'conflict' => ['code', 'requested' => ['starts_at', 'ends_at'], 'conflicts', 'suggestion']])
            ->assertJsonPath('conflict.code', 'schedule_conflict')->assertJsonPath('conflict.requested.starts_at', $this->at('09:15'))->assertJsonPath('conflict.requested.ends_at', $this->at('09:45'))
            ->assertJsonPath('conflict.conflicts.0.title', 'Dentist')->assertJsonPath('conflict.conflicts.0.overlap_minutes', 15)->assertJsonPath('conflict.suggestion.starts_at', $this->at('10:00'));
        $this->assertSame(0, Task::where('title', 'Too early')->count(), 'the task was rolled back with the refused time');
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_a_refused_update_saves_nothing_of_the_task(): void
    {
        $task = $this->task();
        $event = $this->booked($task, '15:00', '15:30');
        $this->busy('09:00', '10:00');
        $before = $this->snapshot($task);

        $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Renamed', 'priority' => 'urgent', 'estimated_minutes' => 120, 'due_at' => '2027-03-01T10:00:00Z', 'schedule' => ['starts_at' => $this->at('09:30')]])
            ->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict');

        $this->assertSame($before, $this->snapshot($task), 'title, priority, estimate and due are as before');
        $this->assertSame('2027-02-03 15:00:00', CalendarEvent::findOrFail($event->id)->starts_at->format('Y-m-d H:i:s'), 'the old session is intact');
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_an_external_event_blocks_and_the_tasks_own_session_does_not(): void
    {
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g1', 'email' => 'g@example.test', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'primary', 'external_id' => 'e1', 'title' => 'Client call', 'starts_at' => '2027-02-03 11:00:00', 'ends_at' => '2027-02-03 12:00:00']);
        $this->postJson('/api/tasks', ['title' => 'Clash', 'schedule' => ['starts_at' => $this->at('11:30')]])->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.kind', 'external');

        $task = $this->task();
        $this->booked($task, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('09:15')]])->assertOk()->assertJsonPath('data.schedule.starts_at', $this->at('09:15'));
    }

    public function test_moving_into_a_busy_slot_is_refused_and_the_old_session_stays(): void
    {
        $task = $this->task();
        $event = $this->booked($task, '13:00', '13:30');
        $this->busy('09:00', '10:00');

        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('09:30')]])->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict');
        $this->assertSame('2027-02-03 13:00:00', CalendarEvent::findOrFail($event->id)->starts_at->format('Y-m-d H:i:s'));
    }

    public function test_null_removes_only_the_session(): void
    {
        $task = $this->task();
        $event = $this->booked($task, '09:00', '09:30');
        $other = $this->busy('12:00', '13:00');

        $response = $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Still here', 'schedule' => null]);
        $this->dump('remove', $response, ['title' => 'Still here', 'schedule' => null]);

        $response->assertOk()->assertJsonPath('data.title', 'Still here')->assertJsonPath('data.schedule', null);
        $this->assertNull(CalendarEvent::find($event->id));
        $this->assertNotNull(CalendarEvent::find($other->id));
        $this->assertSame('Still here', Task::findOrFail($task->id)->title);
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => null])->assertOk()->assertJsonPath('data.schedule', null);
    }

    public function test_split_tasks_need_a_session_id(): void
    {
        $task = $this->task(['split_sessions' => true]);
        $first = $this->booked($task, '09:00', '09:30');
        $second = $this->booked($task, '11:00', '11:30');
        $before = $this->snapshot($task);

        $response = $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Nope', 'schedule' => ['starts_at' => $this->at('14:00')]]);
        $response->assertUnprocessable()->assertJsonPath('code', 'several_sessions')->assertJsonStructure(['errors' => ['schedule'], 'sessions']);
        $this->assertCount(2, $response->json('sessions'));
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => null])->assertUnprocessable()->assertJsonPath('code', 'several_sessions');
        $this->assertSame($before, $this->snapshot($task));
        $this->assertSame(2, CalendarEvent::where('task_id', $task->id)->count());

        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('14:00'), 'session_id' => $second->id]])->assertOk()->assertJsonPath('data.schedule.sessions', 2);
        $this->assertSame('2027-02-03 14:00:00', CalendarEvent::findOrFail($second->id)->starts_at->format('Y-m-d H:i:s'));
        $this->assertSame('2027-02-03 09:00:00', CalendarEvent::findOrFail($first->id)->starts_at->format('Y-m-d H:i:s'), 'the other session is untouched');

        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('15:00'), 'session_id' => 999999]])->assertNotFound()->assertJsonPath('code', 'session_not_found');
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['session_id' => $first->id, 'starts_at' => $this->at('16:00')]])->assertOk();
    }

    public function test_closed_tasks_cannot_get_a_schedule_but_can_lose_one(): void
    {
        $done = $this->task(['status' => 'completed', 'completed_at' => now()]);
        $this->patchJson("/api/tasks/{$done->id}", ['schedule' => ['starts_at' => $this->at('09:00')]])->assertUnprocessable()->assertJsonValidationErrors(['schedule']);
        $this->assertSame(0, CalendarEvent::count());

        $open = $this->task();
        $event = $this->booked($open, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$open->id}", ['status' => 'completed', 'schedule' => ['starts_at' => $this->at('10:00')]])->assertUnprocessable()->assertJsonValidationErrors(['schedule']);
        $this->assertSame('todo', Task::findOrFail($open->id)->status, 'the status change was rolled back too');
        $this->assertSame('2027-02-03 09:00:00', CalendarEvent::findOrFail($event->id)->starts_at->format('Y-m-d H:i:s'));

        $this->postJson('/api/tasks', ['title' => 'Born closed', 'status' => 'cancelled', 'schedule' => ['starts_at' => $this->at('10:00')]])->assertUnprocessable()->assertJsonValidationErrors(['schedule']);
        $this->assertSame(0, Task::where('title', 'Born closed')->count());

        $this->patchJson("/api/tasks/{$open->id}", ['status' => 'completed', 'schedule' => null])->assertOk()->assertJsonPath('data.status', 'completed')->assertJsonPath('data.schedule', null);
        $this->assertNull(CalendarEvent::find($event->id));
    }

    public function test_completing_a_recurring_task_does_not_copy_the_session(): void
    {
        $task = $this->task(['recurrence' => 'daily']);
        $this->booked($task, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['status' => 'completed', 'schedule' => null])->assertOk();
        $next = Task::where('user_id', $this->user->id)->where('id', '!=', $task->id)->sole();
        $this->assertSame(0, CalendarEvent::where('task_id', $next->id)->count());

        $other = $this->task(['recurrence' => 'daily', 'title' => 'Second']);
        $this->booked($other, '10:00', '10:30');
        $this->patchJson("/api/tasks/{$other->id}", ['status' => 'completed'])->assertOk();
        $this->assertSame(0, CalendarEvent::whereIn('task_id', Task::where('title', 'Second')->where('id', '!=', $other->id)->pluck('id'))->count());
    }

    public function test_old_clients_without_schedule_leave_sessions_alone(): void
    {
        $task = $this->task();
        $event = $this->booked($task, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Edited', 'estimated_minutes' => 90])->assertOk()->assertJsonPath('data.schedule.session_id', $event->id)->assertJsonPath('data.schedule.ends_at', $this->at('09:30'));
        $this->postJson('/api/tasks', ['title' => 'Plain'])->assertCreated()->assertJsonPath('data.schedule', null);
        $this->assertSame(1, CalendarEvent::count());
        $this->assertSame('2027-02-03 09:30:00', CalendarEvent::findOrFail($event->id)->ends_at->format('Y-m-d H:i:s'));
    }

    public function test_a_resent_post_with_the_same_idempotency_key_returns_the_first_result(): void
    {
        $body = ['title' => 'Once only', 'schedule' => ['starts_at' => $this->at('09:00')]];
        $first = $this->postJson('/api/tasks', $body, ['Idempotency-Key' => 'abc-1'])->assertCreated();
        $second = $this->postJson('/api/tasks', $body, ['Idempotency-Key' => 'abc-1'])->assertOk()->assertHeader('Idempotent-Replay', 'true');

        $this->assertSame($first->json('data.id'), $second->json('data.id'));
        $this->assertSame($first->json('data.schedule'), $second->json('data.schedule'));
        $this->assertSame(1, Task::where('title', 'Once only')->count());
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_a_resent_patch_with_the_same_idempotency_key_applies_once(): void
    {
        $task = $this->task();
        $this->booked($task, '09:00', '09:30');
        $body = ['title' => 'Moved once', 'schedule' => ['starts_at' => $this->at('10:00')]];
        $this->patchJson("/api/tasks/{$task->id}", $body, ['Idempotency-Key' => 'k-2'])->assertOk()->assertHeaderMissing('Idempotent-Replay');
        $this->patchJson("/api/tasks/{$task->id}", $body, ['Idempotency-Key' => 'k-2'])->assertOk()->assertHeader('Idempotent-Replay', 'true')->assertJsonPath('data.schedule.starts_at', $this->at('10:00'));
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_the_same_client_id_resent_with_a_schedule_returns_the_task_with_its_schedule(): void
    {
        $body = ['title' => 'Offline queued', 'client_id' => '6f1b0d3e-8f4a-4c5e-9d7a-2b1c3d4e5f60', 'schedule' => ['starts_at' => $this->at('09:00')]];
        $this->postJson('/api/tasks', $body)->assertCreated();
        $this->postJson('/api/tasks', $body)->assertOk()->assertJsonPath('data.schedule.starts_at', $this->at('09:00'));
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_another_users_task_is_not_found_and_their_busy_time_does_not_leak(): void
    {
        $other = User::factory()->create();
        $theirs = $this->task([], $other);
        $this->patchJson("/api/tasks/{$theirs->id}", ['title' => 'Hijack', 'schedule' => ['starts_at' => $this->at('09:00')]])->assertNotFound();
        $this->assertSame('Write report', Task::findOrFail($theirs->id)->title);
        $this->assertSame(0, CalendarEvent::count());

        $this->busy('09:00', '10:00', 'Their secret', $other);
        $this->postJson('/api/tasks', ['title' => 'Mine', 'schedule' => ['starts_at' => $this->at('09:00')]])->assertCreated();
        $this->assertSame(1, CalendarEvent::where('user_id', $this->user->id)->count());

        $this->busy('11:00', '12:00', 'My meeting');
        $response = $this->postJson('/api/tasks', ['title' => 'Clash', 'schedule' => ['starts_at' => $this->at('11:00')]])->assertUnprocessable();
        $this->assertStringNotContainsString('Their secret', $response->getContent());
        $theirSession = $this->booked($theirs, '14:00', '14:30');
        $this->assertNotNull(CalendarEvent::find($theirSession->id));
    }

    public function test_the_due_date_is_never_touched_by_the_schedule(): void
    {
        $task = $this->task(['due_at' => '2027-02-05 22:59:00', 'due_all_day' => true]);
        $this->booked($task, '09:00', '09:30');
        $before = $this->snapshot($task);
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('16:00', '2027-02-08')]])->assertOk();
        $after = $this->snapshot($task);
        unset($before['updated_at'], $after['updated_at']);
        $this->assertSame($before, $after);
        $this->assertTrue((bool) Task::findOrFail($task->id)->due_all_day);

        $this->postJson('/api/tasks', ['title' => 'No due', 'schedule' => ['starts_at' => $this->at('16:00')]])->assertCreated()->assertJsonPath('data.due_at', null)->assertJsonPath('data.due_all_day', false);
    }

    public function test_expected_starts_at_guards_a_stale_edit(): void
    {
        $task = $this->task();
        $this->booked($task, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Stale', 'schedule' => ['starts_at' => $this->at('10:00'), 'expected_starts_at' => $this->at('08:30')]])
            ->assertStatus(409)->assertJsonPath('code', 'event_changed');
        $this->assertSame('Write report', Task::findOrFail($task->id)->title);
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('10:00'), 'expected_starts_at' => $this->at('09:00')]])->assertOk();
    }

    public function test_a_move_without_end_or_estimate_keeps_the_sessions_own_length(): void
    {
        $task = $this->task(['estimated_minutes' => 30]);
        $event = $this->booked($task, '09:00', '10:30');
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('13:00')]])
            ->assertOk()->assertJsonPath('data.schedule.session_id', $event->id)->assertJsonPath('data.schedule.ends_at', $this->at('14:30'));
        $this->patchJson("/api/tasks/{$task->id}", ['estimated_minutes' => 45, 'schedule' => ['starts_at' => $this->at('13:00')]])->assertOk()->assertJsonPath('data.schedule.ends_at', $this->at('13:45'));
        $this->postJson('/api/tasks', ['title' => 'New', 'schedule' => ['starts_at' => $this->at('16:00')]])->assertCreated()->assertJsonPath('data.schedule.ends_at', $this->at('16:30'));
    }

    public function test_the_same_idempotency_key_with_a_different_body_is_refused_and_applies_nothing(): void
    {
        $headers = ['Idempotency-Key' => 'reuse-1'];
        $first = $this->postJson('/api/tasks', ['title' => 'One', 'schedule' => ['starts_at' => $this->at('09:00')]], $headers)->assertCreated();
        $this->postJson('/api/tasks', ['title' => 'Two', 'schedule' => ['starts_at' => $this->at('11:00')]], $headers)->assertUnprocessable()->assertJsonPath('code', 'idempotency_key_reused')->assertJsonStructure(['errors' => ['idempotency_key']]);
        $this->assertSame(0, Task::where('title', 'Two')->count());
        $this->assertSame(1, CalendarEvent::count());
        $this->postJson('/api/tasks', ['schedule' => ['starts_at' => $this->at('09:00')], 'title' => 'One'], $headers)->assertOk()->assertJsonPath('data.id', $first->json('data.id'));
    }

    public function test_the_response_shows_the_synced_planned_window_and_a_refusal_leaves_it_alone(): void
    {
        $task = $this->task(['scheduled_start' => '2027-02-03 09:00:00', 'scheduled_end' => '2027-02-03 09:30:00']);
        $this->booked($task, '09:00', '09:30');
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('13:00')]])->assertOk()
            ->assertJsonPath('data.scheduled_start', '2027-02-03T13:00:00.000000Z')->assertJsonPath('data.scheduled_end', '2027-02-03T13:30:00.000000Z');
        $this->assertSame('2027-02-03 13:00:00', Task::findOrFail($task->id)->scheduled_start->format('Y-m-d H:i:s'));

        $this->busy('15:00', '16:00');
        $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('15:15')]])->assertUnprocessable();
        $this->assertSame('2027-02-03 13:00:00', Task::findOrFail($task->id)->scheduled_start->format('Y-m-d H:i:s'), 'a refused save did not sync the window');
    }

    public function test_a_session_id_of_another_task_or_user_is_404_and_never_moved(): void
    {
        $task = $this->task();
        $this->booked($task, '09:00', '09:30');
        $otherTask = $this->task(['title' => 'Other']);
        $theirs = $this->booked($otherTask, '11:00', '11:30');
        $stranger = $this->booked($this->task([], User::factory()->create()), '12:00', '12:30');

        foreach ([$theirs, $stranger] as $event) {
            $this->patchJson("/api/tasks/{$task->id}", ['schedule' => ['starts_at' => $this->at('14:00'), 'session_id' => $event->id]])->assertNotFound()->assertJsonPath('code', 'session_not_found');
        }
        $this->assertSame(['11:00:00', '12:00:00'], [CalendarEvent::findOrFail($theirs->id)->starts_at->format('H:i:s'), CalendarEvent::findOrFail($stranger->id)->starts_at->format('H:i:s')]);
        $this->assertSame(3, CalendarEvent::count());
    }

    public function test_the_longest_estimate_works_and_a_completed_task_can_be_reopened_with_a_schedule(): void
    {
        $this->postJson('/api/tasks', ['title' => 'Marathon', 'estimated_minutes' => 10080, 'schedule' => ['starts_at' => $this->at('09:00')]])
            ->assertCreated()->assertJsonPath('data.schedule.ends_at', '2027-02-10T09:00:00Z');

        $done = $this->task(['status' => 'completed', 'completed_at' => now()]);
        $this->patchJson("/api/tasks/{$done->id}", ['status' => 'todo', 'schedule' => ['starts_at' => $this->at('15:00', '2027-02-12')]])->assertOk()->assertJsonPath('data.status', 'todo')->assertJsonPath('data.schedule.ends_at', $this->at('15:30', '2027-02-12'));
    }

    /** @return iterable<string, array{0: array<string, mixed>, 1: string}> */
    public static function invalidSchedules(): iterable
    {
        yield 'no start' => [['ends_at' => '2027-02-03T10:00:00Z'], 'schedule.starts_at'];
        yield 'not a date' => [['starts_at' => 'tomorrow'], 'schedule.starts_at'];
        yield 'no offset' => [['starts_at' => '2027-02-03T09:00:00'], 'schedule.starts_at'];
        yield 'end before start' => [['starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T09:00:00Z'], 'schedule.ends_at'];
        yield 'end equals start' => [['starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T10:00:00Z'], 'schedule.ends_at'];
        yield 'end without offset' => [['starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T11:00:00'], 'schedule.ends_at'];
        yield 'in the past' => [['starts_at' => '2027-01-31T09:00:00Z', 'ends_at' => '2027-01-31T10:00:00Z'], 'schedule.ends_at'];
        yield 'bad session id' => [['starts_at' => '2027-02-03T10:00:00Z', 'session_id' => 'x'], 'schedule.session_id'];
        yield 'unknown key' => [['starts_at' => '2027-02-03T10:00:00Z', 'foo' => 1], 'schedule'];
    }

    /**
     * @param  array<string, mixed>  $schedule
     */
    #[DataProvider('invalidSchedules')]
    public function test_invalid_schedules_are_422_keyed_by_field_and_save_nothing(array $schedule, string $key): void
    {
        $task = $this->task();
        $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Renamed', 'schedule' => $schedule])->assertUnprocessable()->assertJsonValidationErrors([$key]);
        $this->assertSame('Write report', Task::findOrFail($task->id)->title);
        $this->postJson('/api/tasks', ['title' => 'Never', 'schedule' => $schedule])->assertUnprocessable()->assertJsonValidationErrors([$key]);
        $this->assertSame(0, Task::where('title', 'Never')->count());
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_schedule_is_ignored_for_other_resources(): void
    {
        $this->postJson('/api/projects', ['title' => 'Proj', 'schedule' => ['starts_at' => $this->at('09:00')]])->assertCreated();
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_a_session_crossing_the_spring_dst_change_keeps_its_real_length(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-03-20 08:00', 'UTC'));
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        // 01:30 CET on 2026-03-29, clocks jump 02:00 -> 03:00: two real hours end at 04:30 CEST (02:30Z).
        $this->postJson('/api/tasks', ['title' => 'Night job', 'estimated_minutes' => 120, 'schedule' => ['starts_at' => '2026-03-29T01:30:00+01:00']])
            ->assertCreated()->assertJsonPath('data.schedule.starts_at', '2026-03-29T00:30:00Z')->assertJsonPath('data.schedule.ends_at', '2026-03-29T02:30:00Z');
        CalendarEvent::factory()->create(['user_id' => $this->user->id, 'title' => 'After', 'starts_at' => '2026-03-29 02:30:00', 'ends_at' => '2026-03-29 03:00:00']);
        $this->postJson('/api/tasks', ['title' => 'Adjacent', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => '2026-03-29T05:00:00+02:00']])->assertCreated()->assertJsonPath('data.schedule.ends_at', '2026-03-29T03:30:00Z');
        $this->postJson('/api/tasks', ['title' => 'Overlap', 'estimated_minutes' => 125, 'schedule' => ['starts_at' => '2026-03-28T23:30:00+01:00']])->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.overlap_minutes', 5);
        $this->assertSame(0, Task::where('title', 'Overlap')->count());
    }

    public function test_sessions_crossing_midnight_and_the_autumn_dst_change(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-10-20 08:00', 'UTC'));
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        // 23:30 CEST on the 24th for 90 minutes crosses midnight: ends 01:00 CEST on the 25th (23:00Z).
        $this->postJson('/api/tasks', ['title' => 'Late', 'estimated_minutes' => 90, 'schedule' => ['starts_at' => '2026-10-24T23:30:00+02:00']])
            ->assertCreated()->assertJsonPath('data.schedule.starts_at', '2026-10-24T21:30:00Z')->assertJsonPath('data.schedule.ends_at', '2026-10-24T23:00:00Z');
        // 01:30 CEST on the 25th for 120 minutes spans the repeated hour: real end 01:30Z = 02:30 CET.
        $task = $this->postJson('/api/tasks', ['title' => 'Repeated hour', 'estimated_minutes' => 120, 'schedule' => ['starts_at' => '2026-10-25T01:30:00+02:00']])
            ->assertCreated()->assertJsonPath('data.schedule.ends_at', '2026-10-25T01:30:00Z')->json('data.id');
        $this->patchJson("/api/tasks/{$task}", ['estimated_minutes' => 180, 'schedule' => ['starts_at' => '2026-10-25T01:30:00+02:00']])->assertOk()->assertJsonPath('data.schedule.ends_at', '2026-10-25T02:30:00Z');
        $this->assertSame(2, CalendarEvent::count());
    }
}
