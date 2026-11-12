<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\CalendarAccount;
use App\Models\ExternalTask;
use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** Review follow-ups for date-only deadlines: echo-safe payloads, zone changes vs copy / undo / reminders, and the chunked recompute. */
class DateOnlyDeadlineReviewTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2026-01-15 08:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
    }

    private function utc(?object $at): ?string
    {
        return $at ? CarbonImmutable::instance($at)->utc()->format('Y-m-d\TH:i:s\Z') : null;
    }

    private function allDay(string $date, array $extra = [], ?User $user = null): Task
    {
        return Task::factory()->create($extra + ['user_id' => ($user ?? $this->user)->id, 'status' => 'todo', 'due_at' => Task::endOfDay($date, 'Europe/Amsterdam'), 'due_all_day' => true]);
    }

    public function test_null_due_date_with_a_due_at_makes_a_timed_deadline_instead_of_erasing_it(): void
    {
        $task = $this->allDay('2026-02-13');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['due_date' => null, 'due_at' => '2026-02-20T10:00:00Z'])->assertOk()
            ->assertJsonPath('data.due_at', '2026-02-20T10:00:00.000000Z')->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.due_date', null);
        $this->actingAs($this->user)->postJson('/api/tasks', ['title' => 'x', 'due_date' => null, 'due_at' => '2026-02-20T10:00:00Z'])->assertCreated()
            ->assertJsonPath('data.due_at', '2026-02-20T10:00:00.000000Z');
    }

    public function test_whole_object_echo_of_a_timed_task_is_safe(): void
    {
        $task = Task::factory()->create(['user_id' => $this->user->id, 'due_at' => '2026-02-13 08:00:00', 'due_all_day' => false]);
        $echo = $this->actingAs($this->user)->getJson("/api/tasks/{$task->id}")->json('data');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['title' => 'Edited', 'due_at' => $echo['due_at'], 'due_date' => $echo['due_date'], 'due_all_day' => $echo['due_all_day']])->assertOk()
            ->assertJsonPath('data.due_at', '2026-02-13T08:00:00.000000Z')->assertJsonPath('data.due_all_day', false)->assertJsonPath('data.title', 'Edited');
    }

    public function test_whole_object_echo_of_an_all_day_task_is_unchanged_and_a_mismatch_is_rejected(): void
    {
        $task = $this->allDay('2026-02-13');
        $echo = $this->actingAs($this->user)->getJson("/api/tasks/{$task->id}")->json('data');
        $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['title' => 'Edited', 'due_at' => $echo['due_at'], 'due_date' => $echo['due_date'], 'due_all_day' => $echo['due_all_day']])->assertOk()
            ->assertJsonPath('data.due_at', '2026-02-13T22:59:00.000000Z')->assertJsonPath('data.due_all_day', true)->assertJsonPath('data.due_date', '2026-02-13');
        $this->assertSame(0, (int) $task->fresh()->postponed_count);
        // due_at and due_date disagree: rejected, nothing changes.
        foreach ([['due_at' => '2026-02-20T22:59:00Z', 'due_date' => '2026-02-13'], ['due_at' => '2026-02-13T10:00:00Z', 'due_date' => '2026-02-13'], ['due_at' => $echo['due_at'], 'due_date' => '2026-02-14', 'due_all_day' => true]] as $payload) {
            $this->actingAs($this->user)->patchJson("/api/tasks/{$task->id}", ['title' => 'Nope'] + $payload)->assertUnprocessable()->assertJsonValidationErrors('due_date');
        }
        $this->assertSame('Edited', $task->fresh()->title);
    }

    public function test_copy_of_a_date_only_import_uses_the_current_account_zone(): void
    {
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google_tasks', 'external_account_id' => 'g', 'access_token' => 'a', 'refresh_token' => 'r', 'token_expires_at' => now()->addHour(), 'status' => 'active']);
        // Stored when the account zone was Amsterdam; the zone is now Tokyo and the row was not touched (the instant is stale).
        $ext = ExternalTask::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'external_id' => 'L|1', 'title' => 'Renew', 'due_at' => Task::endOfDay('2026-02-13', 'Europe/Amsterdam'), 'due_is_date' => true, 'status' => 'open']);
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => ['timezone' => 'Asia/Tokyo']]);
        $copy = $this->actingAs($this->user)->postJson("/api/connected/tasks/{$ext->id}/copy")->assertCreated();
        $task = Task::findOrFail($copy->json('id'));
        $this->assertTrue($task->due_all_day);
        $this->assertSame('2026-02-14', $task->dueDate('Asia/Tokyo'), 'the stale instant already reads as the 14th in Tokyo; the end of that local day is what is stored');
        $this->assertSame('2026-02-14T14:59:00Z', $this->utc($task->due_at));
        $this->assertTrue($task->due_at->equalTo(Task::endOfDay($task->dueDate('Asia/Tokyo'), 'Asia/Tokyo')));
    }

    public function test_imported_date_only_dues_follow_a_zone_change_so_a_later_copy_keeps_the_date(): void
    {
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google_tasks', 'external_account_id' => 'g', 'access_token' => 'a', 'refresh_token' => 'r', 'token_expires_at' => now()->addHour(), 'status' => 'active']);
        $ext = ExternalTask::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'external_id' => 'L|1', 'title' => 'Renew', 'due_at' => Task::endOfDay('2026-02-13', 'Europe/Amsterdam'), 'due_is_date' => true, 'status' => 'open']);
        $this->actingAs($this->user)->putJson('/api/settings', ['timezone' => 'Asia/Tokyo'])->assertOk();
        $this->assertSame('2026-02-13T14:59:00Z', $this->utc($ext->fresh()->due_at));
        $task = Task::findOrFail($this->postJson("/api/connected/tasks/{$ext->id}/copy")->assertCreated()->json('id'));
        $this->assertSame('2026-02-13', $task->dueDate('Asia/Tokyo'));
    }

    public function test_undo_after_a_zone_change_rebuilds_the_date_only_deadline_in_the_current_zone(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-10-24 10:00', 'Europe/Amsterdam'));
        $late = $this->allDay('2026-10-23');
        $actions = [['id' => 'a1', 'type' => 'reschedule_task', 'title' => 'Tax', 'task_id' => $late->id, 'from_due_at' => $late->due_at->toIso8601String(), 'due_at' => now()->addDays(2)->utc()->toIso8601String()]];
        $proposal = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'triage', 'provider' => 'local', 'status' => 'pending', 'summary' => 'Plan', 'explanation' => [], 'actions' => $actions, 'expires_at' => now()->addHour()]);
        $this->actingAs($this->user)->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1']])->assertOk();
        $this->assertFalse($late->fresh()->due_all_day);

        $this->putJson('/api/settings', ['timezone' => 'Asia/Tokyo'])->assertOk();
        $this->postJson("/api/assistant/proposals/{$proposal->id}/undo")->assertOk();

        $fresh = $late->fresh();
        $this->assertTrue($fresh->due_all_day);
        $this->assertSame('2026-10-23', $fresh->dueDate('Asia/Tokyo'));
        $this->assertSame('2026-10-23T14:59:00Z', $this->utc($fresh->due_at));
    }

    public function test_changing_the_zone_recomputes_over_two_hundred_tasks_in_chunks_and_leaves_others_alone(): void
    {
        $stranger = User::factory()->create();
        UserSetting::create(['user_id' => $stranger->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $mine = collect(range(1, 205))->map(fn ($i) => $this->allDay(CarbonImmutable::parse('2026-03-01')->addDays($i % 40)->toDateString()));
        $done = $this->allDay('2026-02-10', ['status' => 'completed', 'completed_at' => now()]);
        $theirs = $this->allDay('2026-03-05', [], $stranger);
        $timed = Task::factory()->create(['user_id' => $this->user->id, 'due_at' => '2026-03-05 12:00:00', 'due_all_day' => false]);

        $this->actingAs($this->user)->putJson('/api/settings', ['timezone' => 'America/New_York'])->assertOk();

        foreach ($mine as $t) {
            $t = $t->fresh();
            $this->assertTrue($t->due_at->equalTo(Task::endOfDay($t->dueDate('America/New_York'), 'America/New_York')));
            $this->assertSame(0, (int) $t->postponed_count);
        }
        $this->assertSame('2026-02-11T04:59:00Z', $this->utc($done->fresh()->due_at));
        $this->assertSame('2026-03-05T22:59:00Z', $this->utc($theirs->fresh()->due_at));
        $this->assertSame('2026-03-05T12:00:00Z', $this->utc($timed->fresh()->due_at));
        // Every one of mine kept its calendar date.
        $this->assertSame($mine->map(fn ($t) => $t->due_at->setTimezone('Europe/Amsterdam')->toDateString())->all(), $mine->map(fn ($t) => $t->fresh()->dueDate('America/New_York'))->all());
    }

    public function test_a_zone_change_does_not_renotify_a_deadline_that_was_already_notified(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-01-06 23:00:00', 'UTC'));
        $task = $this->allDay('2027-01-06', ['title' => 'File taxes']);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame(1, InboxNotification::where('user_id', $this->user->id)->where('link', "/tasks?task={$task->id}")->count());

        // Amsterdam 22:59Z -> London 23:59Z: still the same calendar day, the same deadline.
        $this->actingAs($this->user)->putJson('/api/settings', ['timezone' => 'Europe/London'])->assertOk();
        $this->assertSame('2027-01-06T23:59:00Z', $this->utc($task->fresh()->due_at));
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame(1, InboxNotification::where('user_id', $this->user->id)->where('link', "/tasks?task={$task->id}")->count());
    }
}
