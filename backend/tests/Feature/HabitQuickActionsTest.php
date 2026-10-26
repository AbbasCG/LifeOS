<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\InboxNotification;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class HabitQuickActionsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Wednesday 6 January 2027, 07:30 in Amsterdam (06:30 UTC).
        $this->travelTo(CarbonImmutable::parse('2027-01-06 06:30:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00']]);
    }

    private function habit(string $title, ?string $time, string $recurrence = 'daily'): Habit
    {
        return Habit::create(['user_id' => $this->user->id, 'title' => $title, 'recurrence' => $recurrence, 'remind_time' => $time]);
    }

    private function habitReminders(): array
    {
        return InboxNotification::where('kind', 'habit')->orderBy('id')->pluck('title')->all();
    }

    public function test_a_habit_reminder_time_is_saved_and_validated(): void
    {
        $this->actingAs($this->user)->postJson('/api/habits', ['title' => 'Read', 'remind_time' => '07:15'])->assertCreated()->assertJsonPath('data.remind_time', '07:15');
        $this->postJson('/api/habits', ['title' => 'Stretch', 'remind_time' => '7pm'])->assertUnprocessable()->assertJsonValidationErrors('remind_time');
        $id = Habit::where('title', 'Read')->value('id');
        $this->patchJson("/api/habits/{$id}", ['remind_time' => null])->assertOk();
        $this->assertNull(Habit::find($id)->remind_time);
    }

    public function test_habits_remind_once_at_their_local_time_until_logged(): void
    {
        $read = $this->habit('Read', '07:15');
        $this->habit('Meditate', '08:00');
        $this->habit('Journal', null);
        $logged = $this->habit('Stretch', '07:00');
        HabitEntry::create(['habit_id' => $logged->id, 'date' => '2027-01-06']);

        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->artisan('lifeos:reminders')->assertSuccessful();

        $this->assertSame(['Habit: Read'], $this->habitReminders(), 'Only due, unlogged habits remind, once');
        $this->assertDatabaseHas('inbox_notifications', ['title' => 'Habit: Read', 'category' => 'reminders', 'link' => '/?habit='.$read->id, 'body' => 'Not logged today yet.']);

        // The next day it reminds again.
        $this->travelTo(CarbonImmutable::parse('2027-01-07 07:30:00', 'UTC'));
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame(['Habit: Read', 'Habit: Read', 'Habit: Meditate', 'Habit: Stretch'], $this->habitReminders());
    }

    public function test_weekly_habits_remind_once_a_week_and_stop_when_logged_that_week(): void
    {
        $run = $this->habit('Long run', '07:00', 'weekly');
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertDatabaseHas('inbox_notifications', ['title' => 'Habit: Long run', 'body' => 'Not logged this week yet.']);

        $this->travelTo(CarbonImmutable::parse('2027-01-08 07:30:00', 'UTC'));
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertCount(1, $this->habitReminders(), 'Weekly habits remind once per week');

        // Logged on Monday of the next week: no reminder that week.
        $this->travelTo(CarbonImmutable::parse('2027-01-12 07:30:00', 'UTC'));
        HabitEntry::create(['habit_id' => $run->id, 'date' => '2027-01-11']);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertCount(1, $this->habitReminders());
    }

    public function test_habit_reminders_respect_quiet_hours_focus_and_the_arabic_language(): void
    {
        $this->habit('Read', '07:00');
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => ['timezone' => 'Europe/Amsterdam', 'quiet_start' => '22:00', 'quiet_end' => '08:00', 'language' => 'ar']]);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame([], $this->habitReminders(), 'Quiet hours');

        $this->travelTo(CarbonImmutable::parse('2027-01-06 07:30:00', 'UTC'));
        $session = FocusSession::create(['user_id' => $this->user->id, 'status' => 'running', 'kind' => 'focus', 'duration_seconds' => 1500, 'elapsed_seconds' => 0, 'resumed_at' => now(), 'started_at' => now()]);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame([], $this->habitReminders(), 'Not while focusing');

        $session->update(['status' => 'completed', 'completed_at' => now()]);
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $this->assertSame(['عادة: Read'], $this->habitReminders());
        $this->assertDatabaseHas('inbox_notifications', ['title' => 'عادة: Read', 'body' => 'لم تُسجَّل اليوم بعد.']);
    }

    public function test_the_notification_list_offers_the_same_one_tap_actions(): void
    {
        $other = User::factory()->create();
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'reminders', 'kind' => 'habit', 'title' => 'Habit: Read', 'link' => '/?habit=5', 'deduplication_key' => 'h']);
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'focus', 'kind' => 'focus', 'title' => 'Focus session complete', 'link' => '/focus', 'deduplication_key' => 'f']);
        InboxNotification::create(['user_id' => $this->user->id, 'category' => 'reminders', 'kind' => 'reminder', 'title' => 'Reminder: Call', 'link' => '/tasks', 'deduplication_key' => 't']);
        InboxNotification::create(['user_id' => $other->id, 'category' => 'reminders', 'kind' => 'habit', 'title' => 'Theirs', 'link' => '/?habit=9', 'deduplication_key' => 'o']);

        $data = collect($this->actingAs($this->user)->getJson('/api/notifications')->assertOk()->assertJsonCount(3, 'data')->json('data'))->keyBy('kind');
        $this->assertSame([['action' => 'habit-done', 'title' => 'Done', 'link' => '/?habit=5&done=1']], $data['habit']['actions']);
        $this->assertSame(['Start break', 'Focus again'], array_column($data['focus']['actions'], 'title'));
        $this->assertSame([], $data['reminder']['actions']);
    }
}
