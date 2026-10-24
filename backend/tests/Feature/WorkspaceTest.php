<?php

namespace Tests\Feature;

use App\Models\Project;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WorkspaceTest extends TestCase
{
    use RefreshDatabase;

    public function test_guests_cannot_read_private_data(): void
    {
        $this->getJson('/api/tasks')->assertUnauthorized();
    }

    public function test_register_login_and_logout(): void
    {
        $this->postJson('/api/register', ['name' => 'Test', 'email' => 'test@example.com', 'password' => 'strong-password', 'password_confirmation' => 'strong-password'])->assertCreated()->assertJsonMissingPath('password');
        $this->getJson('/api/user')->assertOk();
        $this->postJson('/api/logout')->assertOk();
        $this->postJson('/api/login', ['email' => 'test@example.com', 'password' => 'wrong'])->assertUnprocessable();
        $this->postJson('/api/login', ['email' => 'test@example.com', 'password' => 'strong-password'])->assertOk();
    }

    public function test_task_crud_and_owner_isolation(): void
    {
        $a = User::factory()->create();
        $b = User::factory()->create();
        $id = $this->actingAs($a)->postJson('/api/tasks', ['title' => 'Study', 'user_id' => $b->id])->assertCreated()->json('data.id');
        $this->assertDatabaseHas('tasks', ['id' => $id, 'user_id' => $a->id]);
        $this->actingAs($b)->getJson('/api/tasks/'.$id)->assertNotFound();
        $this->patchJson('/api/tasks/'.$id, ['title' => 'Stolen'])->assertNotFound();
        $this->deleteJson('/api/tasks/'.$id)->assertNotFound();
        $this->actingAs($a)->patchJson('/api/tasks/'.$id, ['status' => 'completed'])->assertOk()->assertJsonPath('data.status', 'completed');
        $this->deleteJson('/api/tasks/'.$id)->assertOk();
        $this->assertDatabaseMissing('tasks', ['id' => $id]);
    }

    public function test_foreign_relationships_and_invalid_inputs_are_rejected(): void
    {
        $owner = User::factory()->create();
        $other = User::factory()->create();
        $project = Project::create(['user_id' => $other->id, 'title' => 'Private']);
        $this->actingAs($owner)->postJson('/api/tasks', ['title' => 'Test', 'project_id' => $project->id])->assertUnprocessable();
        $this->postJson('/api/tasks', ['title' => '', 'estimated_minutes' => -1, 'status' => 'oops'])->assertUnprocessable();
    }

    public function test_calendar_prevents_overlap_but_allows_adjacent_events(): void
    {
        $this->actingAs(User::factory()->create());
        $event = ['title' => 'Meeting', 'starts_at' => '2027-02-01T09:00:00Z', 'ends_at' => '2027-02-01T10:00:00Z'];
        $this->postJson('/api/events', $event)->assertCreated();
        $this->postJson('/api/events', $event)->assertUnprocessable();
        $this->postJson('/api/events', array_replace($event, ['starts_at' => '2027-02-01T10:00:00Z', 'ends_at' => '2027-02-01T11:00:00Z']))->assertCreated();
    }

    public function test_focus_tracks_elapsed_time_once_and_excludes_pauses(): void
    {
        $this->actingAs(User::factory()->create());
        $id = $this->postJson('/api/focus-sessions', ['duration_seconds' => 1500, 'kind' => 'focus'])->assertCreated()->json('id');
        $this->travel(5)->minutes();
        $this->patchJson('/api/focus-sessions/'.$id, ['action' => 'pause'])->assertOk()->assertJsonPath('elapsed_seconds', 300);
        $this->travel(10)->minutes();
        $this->patchJson('/api/focus-sessions/'.$id, ['action' => 'resume'])->assertOk();
        $this->travel(2)->minutes();
        $this->patchJson('/api/focus-sessions/'.$id, ['action' => 'finish'])->assertOk()->assertJsonPath('elapsed_seconds', 420);
        $this->patchJson('/api/focus-sessions/'.$id, ['action' => 'finish'])->assertOk()->assertJsonPath('elapsed_seconds', 420);
        $this->assertDatabaseCount('inbox_notifications', 1);
    }

    public function test_settings_validation_and_persistence(): void
    {
        $this->actingAs(User::factory()->create())->putJson('/api/settings', ['timezone' => 'Europe/Amsterdam', 'language' => 'ar'])->assertOk();
        $this->getJson('/api/settings')->assertJsonPath('language', 'ar');
        $this->putJson('/api/settings', ['timezone' => 'Invalid'])->assertUnprocessable();
    }

    public function test_habit_completion_is_idempotent(): void
    {
        $this->actingAs(User::factory()->create());
        $id = $this->postJson('/api/habits', ['title' => 'Read'])->assertCreated()->json('data.id');
        $entry = ['date' => now()->toDateString(), 'completed' => true];
        $this->putJson('/api/habits/'.$id.'/entry', $entry)->assertOk();
        $this->putJson('/api/habits/'.$id.'/entry',$entry)->assertOk();
        $this->assertDatabaseCount('habit_entries',1);
    }
}
