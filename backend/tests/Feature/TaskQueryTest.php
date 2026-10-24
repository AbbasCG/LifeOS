<?php

namespace Tests\Feature;

use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TaskQueryTest extends TestCase
{
    use RefreshDatabase;

    public function test_search_is_case_insensitive_and_covers_descriptions(): void
    {
        $user = User::factory()->create();
        Task::create(['user_id' => $user->id, 'title' => 'Prepare Laravel talk']);
        Task::create(['user_id' => $user->id, 'title' => 'Groceries', 'description' => 'Buy LARAVEL stickers']);
        Task::create(['user_id' => $user->id, 'title' => 'Unrelated 100%']);

        $this->actingAs($user)->getJson('/api/tasks?search=laravel')->assertJsonCount(2, 'data');
        $this->getJson('/api/tasks?search=!')->assertJsonCount(0, 'data');
        $this->getJson('/api/tasks?search=%25')->assertJsonCount(1, 'data');
    }

    public function test_due_filters_and_priority_sort(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(10, 0));
        $user = User::factory()->create();
        Task::create(['user_id' => $user->id, 'title' => 'Overdue', 'priority' => 'low', 'due_at' => '2027-01-03T10:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Today', 'priority' => 'urgent', 'due_at' => '2027-01-04T15:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'No date', 'priority' => 'high']);
        Task::create(['user_id' => $user->id, 'title' => 'Done late', 'status' => 'completed', 'due_at' => '2027-01-02T10:00:00Z']);

        $this->actingAs($user)->getJson('/api/tasks?due=overdue')->assertJsonCount(1, 'data')->assertJsonPath('data.0.title', 'Overdue');
        $this->getJson('/api/tasks?due=today')->assertJsonCount(1, 'data')->assertJsonPath('data.0.title', 'Today');
        $this->getJson('/api/tasks?due=none')->assertJsonCount(1, 'data');
        $this->getJson('/api/tasks?sort=priority&due=open')->assertJsonPath('data.0.title', 'Today')->assertJsonPath('data.1.title', 'No date')->assertJsonPath('data.2.title', 'Overdue');
        $this->getJson('/api/tasks?sort=due_at')->assertJsonPath('data.0.title', 'Done late')->assertJsonPath('data.3.title', 'No date');
    }

    public function test_tasks_accept_a_reminder_time(): void
    {
        $this->actingAs(User::factory()->create())
            ->postJson('/api/tasks', ['title' => 'Call', 'remind_at' => '2027-01-04T09:00:00Z'])
            ->assertCreated()
            ->assertJsonPath('data.remind_at', '2027-01-04T09:00:00.000000Z');
        $this->postJson('/api/tasks', ['title' => 'Call', 'remind_at' => 'not a date'])->assertUnprocessable();
    }

    public function test_habit_listing_includes_streaks(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 4)->setTime(10, 0));
        $user = User::factory()->create();
        $habit = Habit::create(['user_id' => $user->id, 'title' => 'Walk']);
        foreach (['2027-01-02', '2027-01-03', '2027-01-04'] as $date) {
            HabitEntry::create(['habit_id' => $habit->id, 'date' => $date]);
        }

        $this->actingAs($user)->getJson('/api/habits')
            ->assertJsonPath('data.0.current_streak', 3)
            ->assertJsonPath('data.0.done_today', true)
            ->assertJsonPath('data.0.entries.2.date', '2027-01-04');
    }
}
