<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Task;
use App\Models\User;
use App\Models\WeeklyReview;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WeeklyReviewTest extends TestCase
{
    use RefreshDatabase;

    public function test_review_summarizes_the_week(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 10)->setTime(18, 0));
        $user = User::factory()->create();
        for ($i = 0; $i < 10; $i++) {
            Task::create(['user_id' => $user->id, 'title' => "Done $i", 'status' => 'completed', 'completed_at' => '2027-01-06T10:00:00Z']);
        }
        Task::create(['user_id' => $user->id, 'title' => 'Late', 'due_at' => '2027-01-07T10:00:00Z']);
        Task::create(['user_id' => $user->id, 'title' => 'Next week', 'due_at' => '2027-01-20T10:00:00Z']);
        FocusSession::create(['user_id' => $user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 3600, 'elapsed_seconds' => 3600, 'completed_at' => '2027-01-05T10:00:00Z']);
        Goal::create(['user_id' => $user->id, 'title' => 'Read 10 books', 'target' => 10, 'progress' => 4]);
        $habit = Habit::create(['user_id' => $user->id, 'title' => 'Walk']);
        foreach (range(4, 10) as $day) {
            HabitEntry::create(['habit_id' => $habit->id, 'date' => sprintf('2027-01-%02d', $day)]);
        }

        $this->actingAs($user)->getJson('/api/reviews/2027-01-07')->assertOk()
            ->assertJsonPath('week_start', '2027-01-04')
            ->assertJsonPath('week_end', '2027-01-10')
            ->assertJsonPath('metrics.completed', 10)
            ->assertJsonPath('metrics.focus_minutes', 60)
            ->assertJsonPath('unfinished.0.title', 'Late')
            ->assertJsonCount(1, 'unfinished')
            ->assertJsonPath('goals.0.percent', 40)
            ->assertJsonPath('habits.0.consistency', 100)
            ->assertJsonPath('review.status', 'new')
            ->assertJsonPath('suggested_priorities.0.title', 'Late')
            ->assertJsonFragment(['key' => 'ten_tasks'])
            ->assertJsonFragment(['key' => 'perfect_habit_'.$habit->id])
            ->assertJsonFragment(['key' => 'overdue']);
    }

    public function test_review_workflow_saves_draft_and_applies_confirmed_decisions(): void
    {
        $this->travelTo(now()->setDate(2027, 1, 10)->setTime(18, 0));
        $user = User::factory()->create();
        $done = Task::create(['user_id' => $user->id, 'title' => 'Finish', 'due_at' => '2027-01-07T10:00:00Z', 'recurrence' => 'weekly']);
        $drop = Task::create(['user_id' => $user->id, 'title' => 'Drop', 'due_at' => '2027-01-07T10:00:00Z']);
        $carry = Task::create(['user_id' => $user->id, 'title' => 'Carry', 'due_at' => '2027-01-07T10:00:00Z']);
        $payload = ['reflection' => ['wins' => 'Shipped v1', 'challenges' => '', 'lessons' => 'Plan less', 'rating' => 4], 'decisions' => [$done->id => 'done', $drop->id => 'drop', $carry->id => 'carry'], 'priorities' => [$carry->id]];

        $this->actingAs($user)->putJson('/api/reviews/2027-01-04', $payload)->assertOk()->assertJsonPath('review.status', 'draft')->assertJsonPath('review.reflection.wins', 'Shipped v1');
        $this->assertSame('inbox', $done->fresh()->status);

        $this->postJson('/api/reviews/2027-01-04/complete', $payload)->assertOk()
            ->assertJsonPath('review.status', 'completed')
            ->assertJsonPath('applied', ['done' => 1, 'drop' => 1, 'carry' => 1]);
        $this->assertSame('completed', $done->fresh()->status);
        $this->assertSame('cancelled', $drop->fresh()->status);
        $this->assertSame('todo', $carry->fresh()->status);
        $this->assertDatabaseHas('tasks', ['title' => 'Finish', 'status' => 'todo']);
        $this->assertSame(1, WeeklyReview::count());
        $this->assertNotNull(WeeklyReview::first()->snapshot);
    }

    public function test_review_rejects_foreign_tasks_and_invalid_input(): void
    {
        $user = User::factory()->create();
        $foreign = Task::create(['user_id' => User::factory()->create()->id, 'title' => 'Not yours']);

        $this->actingAs($user)->putJson('/api/reviews/2027-01-04', ['decisions' => [$foreign->id => 'done']])->assertUnprocessable();
        $this->putJson('/api/reviews/2027-01-04', ['priorities' => [$foreign->id]])->assertUnprocessable();
        $this->putJson('/api/reviews/2027-01-04', ['reflection' => ['rating' => 9]])->assertUnprocessable();
        $this->putJson('/api/reviews/2027-01-04', ['decisions' => ['1' => 'explode']])->assertUnprocessable();
        $this->assertSame('inbox', $foreign->fresh()->status);
        $this->getJson('/api/reviews/not-a-date')->assertNotFound();
    }

    public function test_reviews_are_private(): void
    {
        $owner = User::factory()->create();
        WeeklyReview::factory()->create(['user_id' => $owner->id, 'week_start' => '2027-01-04', 'reflection' => ['wins' => 'Secret win']]);

        $response = $this->actingAs(User::factory()->create())->getJson('/api/reviews/2027-01-04')->assertOk();

        $this->assertStringNotContainsString('Secret win', $response->getContent());
        $this->assertSame('new', $response->json('review.status'));
    }
}
