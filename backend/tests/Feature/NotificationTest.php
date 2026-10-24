<?php

namespace Tests\Feature;

use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class NotificationTest extends TestCase
{
    use RefreshDatabase;

    public function test_unread_count_read_all_and_delete_are_owner_scoped(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $first = InboxNotification::create(['user_id' => $user->id, 'title' => 'One', 'deduplication_key' => 'a']);
        InboxNotification::create(['user_id' => $user->id, 'title' => 'Two', 'deduplication_key' => 'b']);
        $foreign = InboxNotification::create(['user_id' => $other->id, 'title' => 'Theirs', 'deduplication_key' => 'c']);

        $this->actingAs($user)->getJson('/api/notifications')->assertOk()->assertJsonPath('unread_count', 2)->assertJsonCount(2, 'data');
        $this->patchJson('/api/notifications/'.$first->id)->assertOk()->assertJsonPath('unread_count', 1);
        $this->getJson('/api/notifications?unread=1')->assertJsonCount(1, 'data');
        $this->patchJson('/api/notifications/'.$foreign->id)->assertNotFound();
        $this->deleteJson('/api/notifications/'.$foreign->id)->assertNotFound();
        $this->postJson('/api/notifications/read-all')->assertOk()->assertJsonPath('unread_count', 0);
        $this->getJson('/api/notifications/unread')->assertJsonPath('unread_count', 0);
        $this->assertNull($foreign->fresh()->read_at);
        $this->deleteJson('/api/notifications/'.$first->id)->assertOk();
        $this->assertDatabaseMissing('inbox_notifications', ['id' => $first->id]);
    }

    public function test_reminder_command_creates_deduplicated_task_reminders(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(8, 0));
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00']]);
        Task::create(['user_id' => $user->id, 'title' => 'Call the bank', 'remind_at' => '2027-01-04T07:55:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Future reminder', 'remind_at' => '2027-01-04T12:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Finished', 'status' => 'completed', 'remind_at' => '2027-01-04T07:00:00Z']);

        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->artisan('lifeos:reminders')->assertSuccessful();

        $this->assertSame(1, InboxNotification::where('kind', 'reminder')->count());
        $this->assertDatabaseHas('inbox_notifications', ['user_id' => $user->id, 'title' => 'Reminder: Call the bank', 'link' => '/tasks']);
    }

    public function test_reminders_respect_quiet_hours(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(23, 0));
        $user = User::factory()->create();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['timezone' => 'UTC', 'quiet_start' => '22:00', 'quiet_end' => '07:00']]);
        Task::create(['user_id' => $user->id, 'title' => 'Late', 'remind_at' => '2027-01-04T22:59:00Z']);

        $this->artisan('lifeos:reminders')->assertSuccessful();

        $this->assertDatabaseCount('inbox_notifications', 0);
    }
}
