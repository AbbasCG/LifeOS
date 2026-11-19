<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarWriteLink;
use App\Models\ExternalEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\PrayerTimes;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Smart postpone: POST /api/tasks/{id}/postpone and its undo. The clock is pinned to Wednesday 2026-11-18 11:00 UTC (UTC account, work 09:00-17:00
 * Monday to Friday, 10-minute breaks), so "tomorrow" is Thursday 2026-11-19.
 */
class TaskPostponeTest extends TestCase
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
        UserSetting::create(['user_id' => $user->id, 'preferences' => $prefs + ['timezone' => 'UTC', 'language' => 'en', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);

        return $user;
    }

    private function at(string $hm, string $date = '2026-11-18', string $tz = 'UTC'): CarbonImmutable
    {
        return CarbonImmutable::parse("{$date} {$hm}", $tz)->utc();
    }

    /** @param array<string, mixed> $extra */
    private function task(string $title = 'Write report', ?CarbonImmutable $due = null, array $extra = [], ?User $user = null): Task
    {
        return Task::create(array_replace(['user_id' => ($user ?? $this->user)->id, 'title' => $title, 'estimated_minutes' => 60, 'priority' => 'medium', 'due_at' => $due, 'status' => 'todo'], $extra));
    }

    private function dateOnly(string $title, string $date, ?User $user = null): Task
    {
        $user ??= $this->user;

        return $this->task($title, Task::endOfDay($date, $user->timezone()), ['due_all_day' => true], $user);
    }

    private function block(Task $task, string $from, string $to, string $date = '2026-11-18', string $kind = 'flexible'): CalendarEvent
    {
        $tz = User::find($task->user_id)->timezone();

        return CalendarEvent::create(['user_id' => $task->user_id, 'task_id' => $task->id, 'title' => $task->title, 'starts_at' => $this->at($from, $date, $tz), 'ends_at' => $this->at($to, $date, $tz), 'kind' => $kind]);
    }

    private function busy(string $from, string $to, string $date = '2026-11-19', ?User $user = null): CalendarEvent
    {
        $user ??= $this->user;

        return CalendarEvent::create(['user_id' => $user->id, 'title' => 'Busy', 'starts_at' => $this->at($from, $date, $user->timezone()), 'ends_at' => $this->at($to, $date, $user->timezone()), 'kind' => 'fixed']);
    }

    /** @param array<string, mixed> $body */
    private function postpone(Task $task, array $body, array $headers = [], ?User $as = null): TestResponse
    {
        return $this->actingAs($as ?? $this->user)->postJson("/api/tasks/{$task->id}/postpone", $body, $headers);
    }

    private function undo(Task $task, string $token, ?User $as = null): TestResponse
    {
        return $this->actingAs($as ?? $this->user)->postJson("/api/tasks/{$task->id}/postpone/undo", ['token' => $token]);
    }

    private function local(CarbonImmutable|string $at, string $tz = 'UTC'): string
    {
        return CarbonImmutable::parse($at)->setTimezone($tz)->format('Y-m-d H:i');
    }

    public function test_tomorrow_moves_the_same_session_with_the_same_length_to_the_first_free_slot(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-11-25'));
        $session = $this->block($task, '14:00', '15:30');
        $this->busy('09:00', '10:00');

        $response = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()
            ->assertJsonPath('data.id', $task->id)
            ->assertJsonPath('data.schedule.session_id', $session->id)
            ->assertJsonPath('data.schedule.starts_at', '2026-11-19T10:10:00Z')
            ->assertJsonPath('data.schedule.ends_at', '2026-11-19T11:40:00Z')
            ->assertJsonPath('moved.session', ['session_id' => $session->id, 'from_starts_at' => '2026-11-18T14:00:00Z', 'from_ends_at' => '2026-11-18T15:30:00Z', 'starts_at' => '2026-11-19T10:10:00Z', 'ends_at' => '2026-11-19T11:40:00Z'])
            ->assertJsonMissingPath('moved.due');

        $this->assertSame(1, CalendarEvent::where('task_id', $task->id)->count(), 'the same row moved, nothing was added');
        $this->assertSame('2026-11-19 10:10', $this->local($session->fresh()->starts_at), 'after the busy hour and a break');
        $this->assertSame(90, (int) $session->fresh()->starts_at->diffInMinutes($session->fresh()->ends_at));
        $this->assertSame('2026-11-25 17:00', $this->local($task->fresh()->due_at), 'a deadline after the new day stays');
        $this->assertSame(0, (int) $task->fresh()->postponed_count, 'a session move alone is not a deadline postponement');
        $this->assertSame(40, strlen($response->json('undo.token')));
        $this->assertSame(now()->addMinutes(10)->toIso8601ZuluString(), $response->json('undo.expires_at'));
        $this->assertSame(1, AuditLog::where('action', 'task_postponed')->count());
    }

    public function test_a_session_and_a_deadline_before_the_new_day_move_together_and_count_once(): void
    {
        $task = $this->task('Send invoice', $this->at('17:00'));
        $this->block($task, '15:00', '16:00');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()
            ->assertJsonPath('moved.session.starts_at', '2026-11-19T09:00:00Z')
            ->assertJsonPath('moved.due', ['from' => '2026-11-18T17:00:00Z', 'to' => '2026-11-19T17:00:00Z', 'due_all_day' => false]);

        $fresh = $task->fresh();
        $this->assertSame('2026-11-19 17:00', $this->local($fresh->due_at));
        $this->assertSame(1, (int) $fresh->postponed_count, 'counted once although the session and the deadline both moved');
        $this->assertNotNull($fresh->last_postponed_at);
    }

    public function test_a_date_only_deadline_moves_to_tomorrow_and_stays_date_only(): void
    {
        $task = $this->dateOnly('Pay rent', '2026-11-18');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()
            ->assertJsonPath('data.due_all_day', true)->assertJsonPath('data.due_date', '2026-11-19')->assertJsonPath('data.schedule', null)
            ->assertJsonPath('moved.due.to', '2026-11-19T23:59:00Z')->assertJsonMissingPath('moved.session');

        $this->assertSame(0, CalendarEvent::count(), 'no session is created for a deadline-only task');
        $this->assertTrue($task->fresh()->due_all_day);
        $this->assertSame(1, (int) $task->fresh()->postponed_count);
    }

    public function test_a_timed_deadline_keeps_its_local_clock_time_on_the_target_day(): void
    {
        $this->user = $this->makeUser(['timezone' => 'America/New_York']);
        $task = $this->task('Call bank', $this->at('15:30', '2026-11-18', 'America/New_York'));

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('data.due_all_day', false);

        $this->assertSame('2026-11-19 15:30', $this->local($task->fresh()->due_at, 'America/New_York'));
    }

    public function test_a_task_with_neither_a_session_nor_a_deadline_is_refused(): void
    {
        $task = $this->task('Someday');

        $this->postpone($task, ['to' => 'tomorrow'])->assertUnprocessable()->assertJsonPath('code', 'nothing_to_postpone')->assertJsonValidationErrors('to');
        $this->postpone($task, ['to' => 'suggest'])->assertUnprocessable()->assertJsonPath('code', 'nothing_to_postpone');
        $this->assertNull($task->fresh()->due_at);
        $this->assertSame(0, CalendarEvent::count());
    }

    public function test_a_deadline_already_after_the_target_is_not_moved_earlier(): void
    {
        $task = $this->task('Later', $this->at('12:00', '2026-12-01'));

        $this->postpone($task, ['to' => 'tomorrow'])->assertUnprocessable()->assertJsonPath('code', 'already_later');
        $this->assertSame('2026-12-01 12:00', $this->local($task->fresh()->due_at));
    }

    /** @return array<string, array{0: int, 1: string}> */
    public static function weekStarts(): array
    {
        return ['sunday' => [0, '2026-11-22'], 'monday' => [1, '2026-11-23'], 'saturday' => [6, '2026-11-21']];
    }

    #[DataProvider('weekStarts')]
    public function test_next_week_is_the_first_day_of_the_users_next_week(int $weekStart, string $expected): void
    {
        $this->user = $this->makeUser(['week_start' => $weekStart]);
        $deadlineOnly = $this->dateOnly('Plan the quarter', '2026-11-18');
        $withSession = $this->task('Deep work', $this->at('17:00', '2026-12-31'));
        $this->block($withSession, '14:00', '15:00');

        $this->postpone($deadlineOnly, ['to' => 'next_week'])->assertOk()->assertJsonPath('data.due_date', $expected);
        $session = $this->postpone($withSession, ['to' => 'next_week'])->assertOk()->json('moved.session.starts_at');

        // Saturday and Sunday are not work days: the session goes to the first work day from there (Monday 23), at the start of work hours.
        $this->assertSame('2026-11-23 09:00', $this->local($session));
    }

    public function test_suggest_writes_nothing_and_the_confirmed_date_books_the_suggested_slot(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-11-19'));
        $session = $this->block($task, '14:00', '15:00');
        $this->busy('09:00', '17:00');
        $before = $session->fresh()->starts_at->toIso8601String();

        $suggestion = $this->postpone($task, ['to' => 'suggest'])->assertOk()->assertJsonMissingPath('undo')->json('suggestion');

        $this->assertSame(['to' => 'date', 'date' => '2026-11-20', 'starts_at' => '2026-11-20T09:00:00Z', 'ends_at' => '2026-11-20T10:00:00Z', 'due_at' => '2026-11-20T17:00:00Z', 'due_all_day' => false, 'has_room' => true], $suggestion, 'Thursday is full: the first day with room');
        $this->assertSame($before, $session->fresh()->starts_at->toIso8601String(), 'a suggestion writes nothing');
        $this->assertSame(0, (int) $task->fresh()->postponed_count);

        $this->postpone($task, ['to' => 'date', 'date' => $suggestion['date']])->assertOk()
            ->assertJsonPath('moved.session.starts_at', $suggestion['starts_at'])->assertJsonPath('moved.due.to', $suggestion['due_at']);
    }

    public function test_suggest_for_a_deadline_only_task_picks_the_first_day_with_room(): void
    {
        $task = $this->dateOnly('Prepare slides', '2026-11-18');
        $this->busy('09:00', '17:00', '2026-11-19');
        $this->busy('09:00', '16:30', '2026-11-20');

        $this->postpone($task, ['to' => 'suggest'])->assertOk()
            ->assertJsonPath('suggestion.date', '2026-11-23')->assertJsonPath('suggestion.due_at', '2026-11-23T23:59:00Z')->assertJsonPath('suggestion.due_all_day', true)
            ->assertJsonPath('suggestion.starts_at', null)->assertJsonPath('suggestion.has_room', true);
        $this->assertSame('2026-11-18', $task->fresh()->dueDate('UTC'));
    }

    public function test_the_date_variant_is_validated(): void
    {
        $task = $this->dateOnly('Pay rent', '2026-11-18');

        $this->postpone($task, ['to' => 'date'])->assertUnprocessable()->assertJsonValidationErrors('date');
        $this->postpone($task, ['to' => 'date', 'date' => '2026-11-17'])->assertUnprocessable()->assertJsonValidationErrors('date');
        $this->postpone($task, ['to' => 'date', 'date' => '19-11-2026'])->assertUnprocessable()->assertJsonValidationErrors('date');
        $this->postpone($task, ['to' => 'tomorrow', 'date' => '2026-11-30'])->assertUnprocessable()->assertJsonValidationErrors('date');
        $this->postpone($task, ['to' => 'later'])->assertUnprocessable()->assertJsonValidationErrors('to');
        $this->assertSame(0, (int) $task->fresh()->postponed_count);

        $this->postpone($task, ['to' => 'date', 'date' => '2026-11-27'])->assertOk()->assertJsonPath('data.due_date', '2026-11-27');
    }

    public function test_no_slot_tomorrow_moves_the_session_to_the_next_work_day(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-11-30'));
        $this->block($task, '14:00', '15:00');
        $this->busy('09:00', '16:30');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.session.starts_at', '2026-11-20T09:00:00Z');
    }

    public function test_no_room_at_all_is_a_structured_conflict_and_nothing_changes(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-12-30'));
        $session = $this->block($task, '14:00', '15:00');
        foreach (range(1, 12) as $d) {
            $this->busy('00:00', '23:59', CarbonImmutable::parse('2026-11-18')->addDays($d)->toDateString());
        }

        $this->postpone($task, ['to' => 'tomorrow'])->assertUnprocessable()
            ->assertJsonPath('conflict.code', 'schedule_conflict')->assertJsonPath('conflict.requested.starts_at', '2026-11-19T09:00:00Z')
            ->assertJsonPath('conflict.conflicts.0.title', 'Busy')->assertJsonValidationErrors('to');
        $this->assertSame('2026-11-18 14:00', $this->local($session->fresh()->starts_at));
    }

    public function test_busy_time_from_a_connected_calendar_blocks_the_slot(): void
    {
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@example.com', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'primary', 'external_id' => 'x1', 'title' => 'Google meeting', 'starts_at' => $this->at('09:00', '2026-11-19'), 'ends_at' => $this->at('11:00', '2026-11-19')]);
        $task = $this->task('Write report', $this->at('17:00', '2026-11-30'));
        $this->block($task, '14:00', '15:00');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.session.starts_at', '2026-11-19T11:10:00Z');
    }

    public function test_prayer_windows_and_ramadan_hours_are_respected(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-02-08 09:00', 'UTC'));
        $this->user = $this->makeUser(['prayer_enabled' => true, 'prayer_lat' => 21.4225, 'prayer_lng' => 39.8262, 'ramadan_mode' => 'on', 'ramadan_work_start' => '10:00', 'ramadan_work_end' => '20:00', 'work_days' => [0, 1, 2, 3, 4, 5, 6]]);
        $day = '2027-02-09';
        $iftar = PrayerTimes::for($this->user->fresh())->iftar($day);
        $this->assertNotNull($iftar);
        $this->busy('10:00', $iftar['starts_at']->subMinutes(25)->format('H:i'), $day);
        $task = $this->task('Evening review', $this->at('23:00', '2027-02-20'));
        $this->block($task, '12:00', '13:00', '2027-02-08');

        $moved = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('moved.session');

        $s = CarbonImmutable::parse($moved['starts_at']);
        $e = CarbonImmutable::parse($moved['ends_at']);
        $this->assertGreaterThanOrEqual($iftar['ends_at'], $s, 'not across iftar');
        $this->assertLessThanOrEqual($this->at('20:00', $day), $e, 'inside the Ramadan hours');
        foreach (PrayerTimes::for($this->user->fresh())->protectedWindows($day) as $w) {
            $this->assertFalse($s < $w[1] && $e > $w[0], 'avoids the prayer windows');
        }
    }

    public function test_ramadan_hours_start_later_than_the_usual_work_start(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-02-08 09:00', 'UTC'));
        $this->user = $this->makeUser(['ramadan_mode' => 'on', 'ramadan_work_start' => '10:00', 'ramadan_work_end' => '15:00']);
        $task = $this->task('Write report', $this->at('23:00', '2027-02-20'));
        $this->block($task, '12:00', '13:00', '2027-02-08');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.session.starts_at', '2027-02-09T10:00:00Z');
    }

    public function test_undo_restores_the_session_the_deadline_and_the_count_exactly_once(): void
    {
        $task = $this->dateOnly('Send invoice', '2026-11-18');
        Task::whereKey($task->id)->update(['postponed_count' => 2, 'last_postponed_at' => '2026-11-10 08:00:00']);
        $session = $this->block($task->fresh(), '15:00', '16:00');
        $token = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('undo.token');
        $this->assertSame(3, (int) $task->fresh()->postponed_count);

        $this->undo($task, $token)->assertOk()->assertJsonPath('data.due_date', '2026-11-18')->assertJsonPath('data.due_all_day', true)
            ->assertJsonPath('data.schedule.starts_at', '2026-11-18T15:00:00Z')->assertJsonPath('data.schedule.ends_at', '2026-11-18T16:00:00Z');

        $fresh = $task->fresh();
        $this->assertSame('2026-11-18T23:59:00+00:00', $fresh->due_at->toIso8601String());
        $this->assertTrue($fresh->due_all_day);
        $this->assertSame(2, (int) $fresh->postponed_count);
        $this->assertSame('2026-11-10 08:00', $this->local($fresh->last_postponed_at));
        $this->assertSame('2026-11-18 15:00', $this->local($session->fresh()->starts_at));
        $this->assertSame(1, CalendarEvent::count());

        $this->undo($task, $token)->assertUnprocessable()->assertJsonPath('code', 'undo_unavailable');
        $this->assertSame(1, AuditLog::where('action', 'task_postpone_undone')->count());
    }

    public function test_undo_expires_after_ten_minutes(): void
    {
        $task = $this->dateOnly('Pay rent', '2026-11-18');
        $token = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('undo.token');

        $this->travel(11)->minutes();

        $this->undo($task, $token)->assertUnprocessable()->assertJsonPath('code', 'undo_unavailable');
        $this->assertSame('2026-11-19', $task->fresh()->dueDate('UTC'));
    }

    public function test_undo_is_for_the_owner_only(): void
    {
        $task = $this->dateOnly('Pay rent', '2026-11-18');
        $token = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('undo.token');
        $other = $this->makeUser();
        $theirs = $this->dateOnly('Their task', '2026-11-18', $other);

        $this->undo($task, $token, $other)->assertNotFound();
        $this->undo($theirs, $token, $other)->assertUnprocessable()->assertJsonPath('code', 'undo_unavailable');
        $this->undo($task, 'not-a-token')->assertUnprocessable();
        $this->assertSame('2026-11-19', $task->fresh()->dueDate('UTC'));

        $this->undo($task, $token)->assertOk();
    }

    public function test_undo_is_refused_with_the_conflict_when_the_old_slot_was_taken(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-11-30'));
        $session = $this->block($task, '15:00', '16:00');
        $token = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('undo.token');
        $blocker = $this->busy('15:30', '16:30', '2026-11-18');

        $this->undo($task, $token)->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict')
            ->assertJsonPath('conflict.conflicts.0.event_id', $blocker->id)->assertJsonValidationErrors('token');
        $this->assertSame('2026-11-19 09:00', $this->local($session->fresh()->starts_at), 'nothing changed');

        $blocker->delete();
        $this->undo($task, $token)->assertOk();
        $this->assertSame('2026-11-18 15:00', $this->local($session->fresh()->starts_at));
    }

    public function test_undo_after_a_later_edit_keeps_the_edit(): void
    {
        $task = $this->dateOnly('Pay rent', '2026-11-18');
        $token = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('undo.token');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_date' => '2026-11-25'])->assertOk();

        $this->undo($task, $token)->assertStatus(409)->assertJsonPath('code', 'changed_since');
        $this->assertSame('2026-11-25', $task->fresh()->dueDate('UTC'));
    }

    public function test_completed_and_cancelled_tasks_are_refused(): void
    {
        foreach (['completed', 'cancelled'] as $status) {
            $task = $this->task("Closed {$status}", $this->at('17:00'), ['status' => $status, 'completed_at' => $status === 'completed' ? now() : null]);

            $this->postpone($task, ['to' => 'tomorrow'])->assertUnprocessable()->assertJsonPath('code', 'task_closed');
            $this->postpone($task, ['to' => 'suggest'])->assertUnprocessable()->assertJsonPath('code', 'task_closed');
            $this->assertSame('2026-11-18 17:00', $this->local($task->fresh()->due_at));
        }
    }

    public function test_a_fixed_or_connected_copy_session_is_not_moved_from_here(): void
    {
        $fixed = $this->task('Fixed one', $this->at('17:00', '2026-11-30'));
        $this->block($fixed, '14:00', '15:00', '2026-11-18', 'fixed');
        $this->postpone($fixed, ['to' => 'tomorrow'])->assertUnprocessable()->assertJsonPath('code', 'session_fixed');

        $copied = $this->task('Copied one', $this->at('17:00', '2026-11-30'));
        $event = $this->block($copied, '15:00', '16:00');
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'email' => 'me@example.com', 'access_token' => 'x', 'status' => 'active']);
        CalendarWriteLink::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_event_id' => $event->id, 'calendar_id' => 'primary', 'external_id' => 'copy-1', 'title' => 'Copied one', 'starts_at' => $event->starts_at, 'ends_at' => $event->ends_at]);
        $this->postpone($copied, ['to' => 'tomorrow'])->assertUnprocessable()->assertJsonPath('code', 'session_linked');
        $this->assertSame('2026-11-18 15:00', $this->local($event->fresh()->starts_at));
    }

    public function test_a_split_task_moves_only_its_next_upcoming_session(): void
    {
        $task = $this->task('Thesis chapter', $this->at('17:00', '2026-11-30'), ['estimated_minutes' => 240, 'split_sessions' => true]);
        $first = $this->block($task, '13:00', '14:00');
        $second = $this->block($task, '15:00', '16:00');
        $third = $this->block($task, '09:00', '10:00', '2026-11-20');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.session.session_id', $first->id)->assertJsonPath('data.schedule.sessions', 3);

        $this->assertSame('2026-11-19 09:00', $this->local($first->fresh()->starts_at));
        $this->assertSame('2026-11-18 15:00', $this->local($second->fresh()->starts_at));
        $this->assertSame('2026-11-20 09:00', $this->local($third->fresh()->starts_at));
    }

    public function test_a_session_never_moves_earlier_than_where_it_was(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-11-30'));
        $session = $this->block($task, '14:00', '15:00', '2026-11-19');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.session.starts_at', '2026-11-19T15:00:00Z');
        $this->assertSame('2026-11-19 15:00', $this->local($session->fresh()->starts_at));
    }

    public function test_an_idempotency_key_replays_the_first_result_and_moves_once(): void
    {
        $task = $this->task('Write report', $this->at('17:00'));
        $session = $this->block($task, '14:00', '15:00');
        $headers = ['Idempotency-Key' => 'tap-1'];

        $first = $this->postpone($task, ['to' => 'tomorrow'], $headers)->assertOk()->assertHeaderMissing('Idempotent-Replay');
        $this->travel(30)->seconds();
        $second = $this->postpone($task, ['to' => 'tomorrow'], $headers)->assertOk()->assertHeader('Idempotent-Replay', 'true');

        $this->assertSame($first->json('undo.token'), $second->json('undo.token'));
        $this->assertSame($first->json('moved'), $second->json('moved'));
        $this->assertSame('2026-11-19 09:00', $this->local($session->fresh()->starts_at), 'moved once');
        $this->assertSame(1, (int) $task->fresh()->postponed_count);
        $this->assertSame(1, AuditLog::where('action', 'task_postponed')->count());

        $this->postpone($task, ['to' => 'next_week'], $headers)->assertUnprocessable()->assertJsonPath('code', 'idempotency_key_reused');
    }

    public function test_a_double_tap_without_a_key_does_not_move_twice(): void
    {
        $task = $this->task('Write report', $this->at('17:00', '2026-11-30'));
        $session = $this->block($task, '14:00', '15:00');

        $first = $this->postpone($task, ['to' => 'tomorrow'])->assertOk();
        $second = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertHeader('Idempotent-Replay', 'true');

        $this->assertSame($first->json('undo.token'), $second->json('undo.token'));
        $this->assertSame('2026-11-19 09:00', $this->local($session->fresh()->starts_at));

        // A deliberate second postpone later on moves it again, to just after where it was.
        $this->travel(20)->seconds();
        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertHeaderMissing('Idempotent-Replay')->assertJsonPath('moved.session.starts_at', '2026-11-19T10:00:00Z');
    }

    public function test_a_stale_expected_updated_at_is_refused(): void
    {
        $task = $this->dateOnly('Pay rent', '2026-11-18');
        $seen = $task->fresh()->updated_at->toIso8601ZuluString();
        $this->travel(1)->minutes();
        $task->update(['title' => 'Pay the rent']);

        $this->postpone($task, ['to' => 'tomorrow', 'expected_updated_at' => $seen])->assertStatus(409)->assertJsonPath('code', 'task_changed');
        $this->assertSame('2026-11-18', $task->fresh()->dueDate('UTC'));
        $this->postpone($task, ['to' => 'tomorrow', 'expected_updated_at' => $task->fresh()->updated_at->toIso8601ZuluString()])->assertOk();
    }

    public function test_a_dst_day_in_europe_amsterdam(): void
    {
        $zone = 'Europe/Amsterdam';
        $this->user = $this->makeUser(['timezone' => $zone, 'work_days' => [0, 1, 2, 3, 4, 5, 6], 'work_start' => '01:00', 'work_end' => '06:00']);
        $this->travelTo(CarbonImmutable::parse('2027-03-27 12:00', $zone));
        $dateOnly = $this->dateOnly('Date only', '2027-03-27');
        $timed = $this->task('Timed', $this->at('10:00', '2027-03-27', $zone));
        $withSession = $this->task('Session', $this->at('23:00', '2027-04-10', $zone));
        $this->block($withSession, '20:00', '21:00', '2027-03-27');

        $this->postpone($dateOnly, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('data.due_date', '2027-03-28')->assertJsonPath('moved.due.to', '2027-03-28T21:59:00Z');
        $this->postpone($timed, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.due.to', '2027-03-28T08:00:00Z');
        $this->assertSame('2027-03-28 10:00', $this->local($timed->fresh()->due_at, $zone), 'the same local clock time after the clocks went forward');
        $moved = $this->postpone($withSession, ['to' => 'tomorrow'])->assertOk()->json('moved.session');

        $this->assertSame('2027-03-28 01:00', $this->local($moved['starts_at'], $zone));
        $this->assertSame(3600, (int) CarbonImmutable::parse($moved['starts_at'])->diffInSeconds(CarbonImmutable::parse($moved['ends_at'])), 'same real length across the gap');
    }

    public function test_another_users_task_is_not_found_and_guests_are_refused(): void
    {
        $other = $this->makeUser();
        $theirs = $this->dateOnly('Their task', '2026-11-18', $other);

        $this->postpone($theirs, ['to' => 'tomorrow'])->assertNotFound();
        $this->postpone($theirs, ['to' => 'suggest'])->assertNotFound();
        $this->assertSame('2026-11-18', $theirs->fresh()->dueDate('UTC'));

        $this->app['auth']->forgetGuards();
        $this->postJson("/api/tasks/{$theirs->id}/postpone", ['to' => 'tomorrow'])->assertUnauthorized();
        $this->postJson("/api/tasks/{$theirs->id}/postpone/undo", ['token' => 'x'])->assertUnauthorized();
    }

    public function test_another_users_calendar_is_not_my_busy_time(): void
    {
        $other = $this->makeUser();
        $this->busy('09:00', '17:00', '2026-11-19', $other);
        $task = $this->task('Write report', $this->at('17:00', '2026-11-30'));
        $this->block($task, '14:00', '15:00');

        $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->assertJsonPath('moved.session.starts_at', '2026-11-19T09:00:00Z');
    }

    public function test_nothing_is_sent_out(): void
    {
        Http::fake();
        config(['ai.provider' => 'openai']);
        $task = $this->task('Private title', $this->at('17:00'));
        $this->block($task, '14:00', '15:00');

        $this->postpone($task, ['to' => 'suggest'])->assertOk();
        $token = $this->postpone($task, ['to' => 'tomorrow'])->assertOk()->json('undo.token');
        $this->undo($task, $token)->assertOk();

        Http::assertNothingSent();
    }
}
