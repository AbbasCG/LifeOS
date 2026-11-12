<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Contract: a date-only deadline is `due_date` ("YYYY-MM-DD") on input. It is stored as tasks.due_at = 23:59:00 of that date in the ACCOUNT
 * timezone (a real instant, so overdue / ordering / reminders are unchanged) plus tasks.due_all_day = true. Output carries due_at, due_all_day
 * and due_date (null unless all-day). Sending due_at (or null) sets a timed / no deadline and clears the flag.
 */
class DateOnlyDeadlineTest extends TestCase
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

    private function utc(?object $at): ?string
    {
        return $at ? CarbonImmutable::instance($at)->utc()->format('Y-m-d\TH:i:s\Z') : null;
    }

    private function allDay(string $date, array $extra = []): Task
    {
        return Task::factory()->create($extra + ['user_id' => $this->user->id, 'status' => 'todo', 'due_at' => Task::endOfDay($date, 'Europe/Amsterdam'), 'due_all_day' => true]);
    }

    public function test_create_with_due_date_stores_end_of_day_in_the_account_zone_and_returns_the_contract(): void
    {
        $res = $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'Pay rent', 'due_date' => '2026-02-13'])->assertCreated()
            ->assertJsonPath('data.due_all_day', true)
            ->assertJsonPath('data.due_date', '2026-02-13')
            ->assertJsonPath('data.due_at', '2026-02-13T22:59:00.000000Z');
        $task = Task::findOrFail($res->json('data.id'));
        $this->assertTrue($task->due_all_day);
        $this->assertSame('2026-02-13T22:59:00Z', $this->utc($task->due_at));
    }

    public function test_user_without_a_timezone_setting_falls_back_to_utc(): void
    {
        $other = User::factory()->create();
        $this->actingAs($other)->postJson('/api/tasks', ['title' => 'x', 'due_date' => '2026-02-13'])->assertCreated()
            ->assertJsonPath('data.due_at', '2026-02-13T23:59:00.000000Z')->assertJsonPath('data.due_date', '2026-02-13');
    }

    public function test_old_client_payload_without_the_flag_is_unchanged(): void
    {
        $res = $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'Call', 'due_at' => '2026-02-12T10:30:00+01:00'])->assertCreated()
            ->assertJsonPath('data.due_at', '2026-02-12T09:30:00.000000Z')->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_date', null);
        // An old client editing only the title does not disturb an all-day deadline.
        $task = $this->allDay('2026-02-13');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['title' => 'Renamed'])->assertOk()
            ->assertJsonPath('data.due_all_day', true)->assertJsonPath('data.due_date', '2026-02-13');
        $this->assertSame('2026-02-13T22:59:00Z', $this->utc($task->fresh()->due_at));
        // A date-only string sent as due_at by an old client keeps its old meaning (start of day UTC, a timed deadline).
        $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'Old', 'due_at' => '2026-02-13'])->assertCreated()
            ->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_at', '2026-02-13T00:00:00.000000Z');
    }

    public function test_update_to_a_new_date_a_time_and_clear(): void
    {
        $task = $this->allDay('2026-02-13');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_date' => '2026-02-20'])->assertOk()
            ->assertJsonPath('data.due_date', '2026-02-20')->assertJsonPath('data.due_at', '2026-02-20T22:59:00.000000Z');
        // An explicit time clears the flag.
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => '2026-02-20T22:59:00Z'])->assertOk()
            ->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_date', null)->assertJsonPath('data.due_at', '2026-02-20T22:59:00.000000Z');
        // Back to a date, then clear the deadline altogether (either field).
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_date' => '2026-02-21'])->assertOk()->assertJsonPath('data.due_all_day', true);
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_date' => null])->assertOk()
            ->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_at', null)->assertJsonPath('data.due_date', null);
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_date' => '2026-02-21'])->assertOk();
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_at' => null])->assertOk()
            ->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_at', null);
        $this->assertDatabaseHas('tasks', ['id' => $task->id, 'due_at' => null, 'due_all_day' => false]);
    }

    public function test_due_all_day_false_alone_keeps_the_instant_but_drops_the_flag(): void
    {
        $task = $this->allDay('2026-02-13');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_all_day' => false])->assertOk()
            ->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_at', '2026-02-13T22:59:00.000000Z');
    }

    /** @return array<string, array{array<string, mixed>, string}> */
    public static function invalidPayloads(): array
    {
        return [
            'not a date' => [['due_date' => 'friday'], 'due_date'],
            'wrong format' => [['due_date' => '13/02/2026'], 'due_date'],
            'impossible day' => [['due_date' => '2026-02-30'], 'due_date'],
            'with a time' => [['due_date' => '2026-02-13T10:00:00Z'], 'due_date'],
            'absurd year' => [['due_date' => '2500-01-01'], 'due_date'],
            'both due_at and due_date' => [['due_date' => '2026-02-13', 'due_at' => '2026-02-13T10:00:00Z'], 'due_date'],
            'flag true without a date' => [['due_all_day' => true], 'due_date'],
            'flag true with only due_at' => [['due_all_day' => true, 'due_at' => '2026-02-13T10:00:00Z'], 'due_date'],
            'flag false with a date' => [['due_all_day' => false, 'due_date' => '2026-02-13'], 'due_all_day'],
            'flag not boolean' => [['due_all_day' => 'maybe'], 'due_all_day'],
        ];
    }

    #[DataProvider('invalidPayloads')]
    public function test_invalid_payloads_are_rejected_and_change_nothing(array $payload, string $field): void
    {
        $task = $this->allDay('2026-02-13');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", $payload)->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'New'] + $payload)->assertUnprocessable()->assertJsonValidationErrors($field);
        $this->assertSame('2026-02-13T22:59:00Z', $this->utc($task->fresh()->due_at));
        $this->assertSame(1, Task::count());
    }

    public function test_flag_true_with_its_date_is_accepted(): void
    {
        $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'x', 'due_all_day' => true, 'due_date' => '2026-02-13'])->assertCreated()
            ->assertJsonPath('data.due_date', '2026-02-13');
    }

    public function test_list_and_show_carry_the_fields_in_the_account_zone(): void
    {
        $task = $this->allDay('2026-02-13');
        $timed = Task::factory()->create(['user_id' => $this->user->id, 'due_at' => '2026-02-13 08:00:00', 'due_all_day' => false]);
        $rows = collect($this->actingAs($this->user)->getJson('/api/tasks')->assertOk()->json('data'))->keyBy('id');
        $this->assertTrue($rows[$task->id]['due_all_day']);
        $this->assertSame('2026-02-13', $rows[$task->id]['due_date']);
        $this->assertFalse($rows[$timed->id]['due_all_day']);
        $this->assertNull($rows[$timed->id]['due_date']);
        $this->actingAs($this->user)->getJson("/api/tasks/{$task->id}")->assertJsonPath('data.due_date', '2026-02-13');
    }

    public function test_other_users_cannot_read_or_change_my_date_only_task(): void
    {
        $task = $this->allDay('2026-02-13');
        $stranger = User::factory()->create();
        $this->actingAs($stranger)->patchJson("/api/tasks/{$task->id}", ['due_date' => '2026-03-01'])->assertNotFound();
        $this->actingAs($stranger)->getJson("/api/tasks/{$task->id}")->assertNotFound();
        $this->assertSame('2026-02-13T22:59:00Z', $this->utc($task->fresh()->due_at));
        // A stranger's own date is stored in THEIR zone, not mine.
        UserSetting::create(['user_id' => $stranger->id, 'preferences' => ['timezone' => 'America/New_York']]);
        $this->actingAs($stranger)->postJson('/api/tasks', ['title' => 'Theirs', 'due_date' => '2026-02-13'])->assertCreated()
            ->assertJsonPath('data.due_at', '2026-02-14T04:59:00.000000Z')->assertJsonPath('data.due_date', '2026-02-13');
    }

    /** @return array<string, array{string, string}> */
    public static function dstDays(): array
    {
        return [
            'before spring forward' => ['2026-03-28', '2026-03-28T22:59:00Z'],
            'spring forward day (23h)' => ['2026-03-29', '2026-03-29T21:59:00Z'],
            'day after' => ['2026-03-30', '2026-03-30T21:59:00Z'],
            'fall back day (25h)' => ['2026-10-25', '2026-10-25T22:59:00Z'],
            'day before fall back' => ['2026-10-24', '2026-10-24T21:59:00Z'],
        ];
    }

    #[DataProvider('dstDays')]
    public function test_end_of_day_is_2359_local_on_dst_days(string $date, string $expectedUtc): void
    {
        $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'DST', 'due_date' => $date])->assertCreated()
            ->assertJsonPath('data.due_at', CarbonImmutable::parse($expectedUtc)->format('Y-m-d\TH:i:s.u\Z'))->assertJsonPath('data.due_date', $date);
    }

    public function test_daily_recurrence_keeps_all_day_and_lands_on_end_of_day_across_dst(): void
    {
        $task = $this->allDay('2026-03-28', ['recurrence' => 'daily']);
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['status' => 'completed'])->assertOk();
        $next = Task::where('id', '!=', $task->id)->firstOrFail();
        $this->assertTrue($next->due_all_day);
        $this->assertSame('2026-03-29T21:59:00Z', $this->utc($next->due_at));
        // Completing the spring-forward occurrence moves to the 30th: 23:59 CEST, not 22:59Z carried over from the day before.
        $next->update(['status' => 'completed']);
        $next->createNextOccurrence();
        $third = Task::orderByDesc('id')->first();
        $this->assertSame('2026-03-30T21:59:00Z', $this->utc($third->due_at));
        $this->assertTrue($third->due_all_day);
    }

    public function test_weekly_recurrence_across_the_fall_back_day(): void
    {
        $task = $this->allDay('2026-10-21', ['recurrence' => 'weekly']);
        $next = $task->createNextOccurrence();
        $this->assertSame('2026-10-28T22:59:00Z', $this->utc($next->fresh()->due_at));
        $this->assertTrue($next->fresh()->due_all_day);
        $this->assertSame('2026-10-28', $next->fresh()->dueDate('Europe/Amsterdam'));
    }

    public function test_timed_recurrence_is_unchanged(): void
    {
        $task = Task::factory()->create(['user_id' => $this->user->id, 'recurrence' => 'daily', 'due_at' => '2026-03-28 17:00:00']);
        $next = $task->createNextOccurrence();
        $this->assertFalse((bool) $next->fresh()->due_all_day);
        $this->assertSame('2026-03-29T17:00:00Z', $this->utc($next->fresh()->due_at));
    }

    public function test_overdue_boundary_a_date_only_task_due_today_is_not_overdue_until_the_day_ends_in_the_account_zone(): void
    {
        $task = $this->allDay('2026-02-13');
        $dueToday = fn () => collect($this->actingAs($this->user)->getJson('/api/tasks?due=overdue')->json('data'))->pluck('id')->all();
        // 23:58 Amsterdam on the 13th = 22:58Z: still today.
        $this->travelTo(CarbonImmutable::parse('2026-02-13 22:58:00', 'UTC'));
        $this->assertNotContains($task->id, $dueToday());
        $this->assertContains($task->id, collect($this->actingAs($this->user)->getJson('/api/tasks?due=today')->json('data'))->pluck('id')->all());
        // 09:00 UTC on the 13th is mid-day in Amsterdam, and is not "yesterday's midnight UTC" overdue.
        $this->travelTo(CarbonImmutable::parse('2026-02-13 23:00:00', 'UTC'));
        $this->assertContains($task->id, $dueToday());
        $this->travelTo(CarbonImmutable::parse('2026-02-12 23:30:00', 'UTC'));
        $this->assertNotContains($task->id, $dueToday());
    }

    public function test_overdue_boundary_in_a_zone_behind_utc(): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => ['timezone' => 'America/Los_Angeles']]);
        $res = $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'West', 'due_date' => '2026-02-13'])->assertCreated();
        $id = $res->json('data.id');
        $this->assertSame('2026-02-14T07:59:00Z', $this->utc(Task::find($id)->due_at));
        // 20:00 UTC on the 13th is already 12:00 LA... and 07:00Z on the 14th is 23:00 LA: not overdue.
        $this->travelTo(CarbonImmutable::parse('2026-02-14 07:00:00', 'UTC'));
        $this->assertNotContains($id, collect($this->actingAs($this->user)->getJson('/api/tasks?due=overdue')->json('data'))->pluck('id')->all());
        $this->travelTo(CarbonImmutable::parse('2026-02-14 08:00:00', 'UTC'));
        $this->assertContains($id, collect($this->actingAs($this->user)->getJson('/api/tasks?due=overdue')->json('data'))->pluck('id')->all());
    }

    public function test_changing_the_account_timezone_keeps_the_calendar_date_and_leaves_everything_else_alone(): void
    {
        $allDay = $this->allDay('2026-02-13');
        $timed = Task::factory()->create(['user_id' => $this->user->id, 'due_at' => '2026-02-13 15:00:00', 'due_all_day' => false]);
        $done = $this->allDay('2026-02-10', ['status' => 'completed', 'completed_at' => now()]);
        $stranger = User::factory()->create();
        UserSetting::create(['user_id' => $stranger->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $theirs = Task::factory()->create(['user_id' => $stranger->id, 'due_at' => Task::endOfDay('2026-02-13', 'Europe/Amsterdam'), 'due_all_day' => true]);
        $session = CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $allDay->id, 'title' => 's', 'kind' => 'flexible', 'starts_at' => '2026-02-03T09:00:00Z', 'ends_at' => '2026-02-03T10:00:00Z']);
        $allDay->forceFill(['postponed_count' => 0])->save();

        $this->actingAs($this->user)->putJson('/api/settings', ['timezone' => 'America/New_York'])->assertOk()->assertJsonPath('timezone', 'America/New_York');

        $this->assertSame('2026-02-14T04:59:00Z', $this->utc($allDay->fresh()->due_at));
        $this->assertSame('2026-02-13', $this->actingAs($this->user)->getJson("/api/tasks/{$allDay->id}")->json('data.due_date'));
        $this->assertSame('2026-02-11T04:59:00Z', $this->utc($done->fresh()->due_at));
        $this->assertSame('2026-02-13T15:00:00Z', $this->utc($timed->fresh()->due_at));
        $this->assertSame('2026-02-13T22:59:00Z', $this->utc($theirs->fresh()->due_at));
        $this->assertSame(0, (int) $allDay->fresh()->postponed_count, 'moving the zone is not a postponement');
        $this->assertSame('2026-02-03T10:00:00Z', $this->utc($session->fresh()->ends_at));
        // Saving settings without changing the zone does nothing to deadlines.
        $this->actingAs($this->user)->putJson('/api/settings', ['timezone' => 'America/New_York', 'theme' => 'dark'])->assertOk();
        $this->assertSame('2026-02-14T04:59:00Z', $this->utc($allDay->fresh()->due_at));
    }

    public function test_an_assistant_style_direct_update_to_another_instant_clears_the_flag(): void
    {
        $task = $this->allDay('2026-02-13');
        $task->update(['due_at' => '2026-02-13 15:00:00']);
        $this->assertFalse($task->fresh()->due_all_day);
        $task2 = $this->allDay('2026-02-13');
        $task2->update(['due_at' => Task::endOfDay('2026-02-14', 'Europe/Amsterdam')]);
        $this->assertTrue($task2->fresh()->due_all_day);
        $task2->update(['due_at' => null]);
        $this->assertFalse($task2->fresh()->due_all_day);
    }

    public function test_moving_a_scheduled_session_never_changes_a_date_only_deadline(): void
    {
        $task = $this->allDay('2026-02-13');
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => 's', 'kind' => 'flexible', 'starts_at' => '2026-02-03T09:00:00Z', 'ends_at' => '2026-02-03T10:00:00Z']);
        $this->actingAs($this->user)->putJson("/api/tasks/{$task->id}/schedule", ['starts_at' => '2026-02-04T09:00:00Z', 'ends_at' => '2026-02-04T10:00:00Z'])->assertSuccessful();
        $fresh = $task->fresh();
        $this->assertTrue($fresh->due_all_day);
        $this->assertSame('2026-02-13T22:59:00Z', $this->utc($fresh->due_at));
    }

    public function test_the_migration_adds_the_column_to_existing_rows_as_false_and_is_rerunnable(): void
    {
        $migration = require database_path('migrations/2026_11_12_100001_add_due_all_day_to_tasks.php');
        $migration->down();
        $this->assertFalse(Schema::hasColumn('tasks', 'due_all_day'));
        $now = now();
        DB::table('tasks')->insert([
            ['user_id' => $this->user->id, 'title' => 'old timed', 'status' => 'todo', 'priority' => 'medium', 'estimated_minutes' => 30, 'due_at' => '2026-02-13 22:59:00', 'created_at' => $now, 'updated_at' => $now],
            ['user_id' => $this->user->id, 'title' => 'old none', 'status' => 'todo', 'priority' => 'medium', 'estimated_minutes' => 30, 'due_at' => null, 'created_at' => $now, 'updated_at' => $now],
        ]);
        $migration->up();
        $migration->up();
        $this->assertTrue(Schema::hasColumn('tasks', 'due_all_day'));
        $rows = DB::table('tasks')->orderBy('id')->get();
        $this->assertCount(2, $rows);
        $this->assertEquals([0, 0], $rows->pluck('due_all_day')->map(fn ($v) => (int) $v)->all());
        $this->assertSame('2026-02-13T22:59:00Z', CarbonImmutable::parse($rows[0]->due_at, 'UTC')->utc()->format('Y-m-d\TH:i:s\Z'), 'existing deadlines are not rewritten');
        $this->actingAs($this->user)->getJson('/api/tasks')->assertOk()->assertJsonPath('data.0.due_all_day', false);
    }
}
