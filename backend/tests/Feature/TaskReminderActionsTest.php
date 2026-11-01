<?php

namespace Tests\Feature;

use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TaskReminderActionsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Wednesday 6 January 2027, 10:00 in Amsterdam (09:00 UTC).
        $this->travelTo(CarbonImmutable::parse('2027-01-06 09:00:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
    }

    public function test_task_reminders_and_deadlines_point_to_their_own_task(): void
    {
        $call = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Call the bank', 'status' => 'todo', 'remind_at' => now()->subMinutes(5), 'due_at' => null]);
        $late = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'File the form', 'status' => 'todo', 'remind_at' => null, 'due_at' => now()->subHours(2)]);
        $soon = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Send the report', 'status' => 'todo', 'remind_at' => null, 'due_at' => now()->addMinutes(30)]);

        $this->artisan('lifeos:reminders')->assertSuccessful();

        $links = InboxNotification::where('user_id', $this->user->id)->pluck('link', 'kind')->all();
        $this->assertSame("/tasks?task={$call->id}", $links['reminder']);
        $this->assertSame("/tasks?task={$late->id}", $links['overdue']);
        $this->assertSame("/tasks?task={$soon->id}", $links['due']);
    }

    public function test_the_list_offers_done_and_a_snooze_that_fits_the_kind(): void
    {
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'reminders', 'kind' => 'reminder', 'title' => 'Reminder: Call', 'link' => '/tasks?task=12', 'deduplication_key' => 'a']);
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'deadlines', 'kind' => 'overdue', 'title' => 'Overdue: File', 'link' => '/tasks?task=13', 'deduplication_key' => 'b']);
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'deadlines', 'kind' => 'due', 'title' => 'Task due: Send', 'link' => '/tasks?task=14', 'deduplication_key' => 'c']);

        $data = collect($this->actingAs($this->user)->getJson('/api/notifications')->assertOk()->json('data'))->keyBy('kind');
        $this->assertSame([
            ['action' => 'task-done', 'title' => 'Done', 'link' => '/?task=12&done=1'],
            ['action' => 'task-snooze', 'title' => 'In 1 hour', 'link' => '/?task=12&snooze=hour'],
        ], $data['reminder']['actions']);
        foreach (['overdue' => 13, 'due' => 14] as $kind => $id) {
            $this->assertSame([
                ['action' => 'task-done', 'title' => 'Done', 'link' => "/?task={$id}&done=1"],
                ['action' => 'task-snooze', 'title' => 'Tomorrow', 'link' => "/?task={$id}&snooze=tomorrow"],
            ], $data[$kind]['actions']);
        }
    }

    public function test_the_buttons_follow_the_account_language(): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => ['timezone' => 'Europe/Amsterdam', 'language' => 'ar']]);
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'reminders', 'kind' => 'reminder', 'title' => 'تذكير', 'link' => '/tasks?task=12', 'deduplication_key' => 'a']);

        $actions = $this->actingAs($this->user)->getJson('/api/notifications')->assertOk()->json('data.0.actions');
        $this->assertSame(['تم', 'بعد ساعة'], array_column($actions, 'title'));
    }

    public function test_older_notifications_without_a_task_keep_working_and_offer_nothing_else(): void
    {
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'reminders', 'kind' => 'reminder', 'title' => 'Reminder: Old', 'link' => '/tasks', 'deduplication_key' => 'a']);
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'reminders', 'kind' => 'reminder', 'title' => 'Reminder: Odd', 'link' => '/tasks?task=1;drop', 'deduplication_key' => 'b']);

        $data = $this->actingAs($this->user)->getJson('/api/notifications')->assertOk()->json('data');
        foreach ($data as $row) {
            $this->assertSame([], $row['actions']);
        }
    }
}
