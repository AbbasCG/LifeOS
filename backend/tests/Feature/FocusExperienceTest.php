<?php

namespace Tests\Feature;

use App\Models\FocusSession;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class FocusExperienceTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-10 09:00', 'UTC'));
        $this->user = User::factory()->create();
    }

    public function test_session_links_task_and_project_and_retries_do_not_duplicate(): void
    {
        $project = Project::create(['user_id' => $this->user->id, 'title' => 'Thesis']);
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Write intro', 'project_id' => $project->id]);
        $id = (string) Str::uuid();
        $payload = ['task_id' => $task->id, 'duration_seconds' => 1500, 'kind' => 'focus', 'mode' => 'pomodoro', 'cycle' => 1, 'client_id' => $id];

        $first = $this->actingAs($this->user)->postJson('/api/focus-sessions', $payload)->assertCreated()->assertJsonPath('project_id', $project->id)->assertJsonPath('task.title', 'Write intro')->assertJsonPath('mode', 'pomodoro');
        $this->postJson('/api/focus-sessions', $payload)->assertOk()->assertJsonPath('id', $first->json('id'));
        $this->assertSame(1, FocusSession::count());

        $other = Project::create(['user_id' => User::factory()->create()->id, 'title' => 'Theirs']);
        $this->postJson('/api/focus-sessions', ['project_id' => $other->id, 'duration_seconds' => 600, 'kind' => 'focus'])->assertUnprocessable();
    }

    public function test_distractions_and_notes_are_logged_and_time_counts_once(): void
    {
        $task = Task::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'actual_minutes' => 0]);
        $id = $this->actingAs($this->user)->postJson('/api/focus-sessions', ['task_id' => $task->id, 'duration_seconds' => 3600, 'kind' => 'focus', 'mode' => 'deep'])->json('id');

        $this->travel(10)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'interrupt', 'reason' => 'phone', 'note' => 'Call from bank'])->assertOk()->assertJsonPath('interruptions.0.reason', 'phone')->assertJsonPath('interruptions.0.elapsed', 600);
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'interrupt', 'reason' => 'boredom'])->assertUnprocessable();
        $this->travel(5)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'pause'])->assertOk()->assertJsonPath('elapsed_seconds', 900);
        $this->travel(30)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'resume'])->assertOk();
        $this->travel(15)->minutes();
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish', 'notes' => 'Outline done'])->assertOk()->assertJsonPath('status', 'completed')->assertJsonPath('elapsed_seconds', 1800)->assertJsonPath('notes', 'Outline done');
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'finish'])->assertOk();

        $this->assertSame(30, $task->fresh()->actual_minutes, 'paused time is excluded and finishing twice counts once');
        $this->patchJson("/api/focus-sessions/{$id}", ['action' => 'note', 'notes' => 'Edited later'])->assertOk()->assertJsonPath('notes', 'Edited later');
    }

    public function test_manual_entries_cannot_overlap_logged_time(): void
    {
        FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 1800, 'elapsed_seconds' => 1800, 'started_at' => now()->subMinutes(40), 'completed_at' => now()->subMinutes(10)]);

        $this->actingAs($this->user)->postJson('/api/focus-sessions', ['duration_seconds' => 1800, 'kind' => 'manual'])->assertUnprocessable()->assertJsonValidationErrors('duration_seconds');
        $this->postJson('/api/focus-sessions', ['duration_seconds' => 600, 'kind' => 'manual'])->assertCreated();
    }

    public function test_insights_summarise_volume_consistency_and_distractions(): void
    {
        foreach ([0, 1, 2, 4] as $d) {
            FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'mode' => $d === 0 ? 'deep' : 'pomodoro', 'status' => 'completed', 'duration_seconds' => 3000, 'elapsed_seconds' => 3000,
                'started_at' => now()->subDays($d)->setTime(8, 0), 'completed_at' => now()->subDays($d)->setTime(8, 50), 'interruptions' => $d === 1 ? [['at' => now()->toIso8601String(), 'reason' => 'phone'], ['at' => now()->toIso8601String(), 'reason' => 'phone']] : null]);
        }
        FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'cancelled', 'duration_seconds' => 1500, 'elapsed_seconds' => 300, 'created_at' => now()->subDay()]);
        FocusSession::create(['user_id' => User::factory()->create()->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 3000, 'elapsed_seconds' => 3000, 'completed_at' => now()]);

        $this->actingAs($this->user)->getJson('/api/focus-sessions/insights?days=7')->assertOk()
            ->assertJsonPath('sessions', 4)->assertJsonPath('minutes', 200)->assertJsonPath('deep_minutes', 200)
            ->assertJsonPath('streak_days', 3)->assertJsonPath('focus_days', 4)->assertJsonPath('completion_rate', 80)
            ->assertJsonPath('distractions.0.reason', 'phone')->assertJsonPath('distractions.0.count', 2)->assertJsonPath('best_hour', 8);
    }
}
