<?php

namespace Tests\Feature;

use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class OfflineSyncTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_task_queued_offline_is_created_once_even_when_sent_twice(): void
    {
        $user = User::factory()->create();
        $id = (string) Str::uuid();
        $payload = ['title' => 'Call the bank', 'status' => 'todo', 'priority' => 'high', 'client_id' => $id];

        $first = $this->actingAs($user)->postJson('/api/tasks', $payload)->assertCreated()->json('data');
        $again = $this->postJson('/api/tasks', $payload + ['title' => 'Changed title'])->assertOk()->json('data');

        $this->assertSame($first['id'], $again['id']);
        $this->assertSame('Call the bank', $again['title'], 'A replay returns the first task unchanged');
        $this->assertSame(1, Task::where('user_id', $user->id)->count());
    }

    public function test_device_ids_are_per_user_validated_and_immutable(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        $id = (string) Str::uuid();

        $this->actingAs($other)->postJson('/api/tasks', ['title' => 'Theirs', 'client_id' => $id])->assertCreated();
        $mine = $this->actingAs($user)->postJson('/api/tasks', ['title' => 'Mine', 'client_id' => $id])->assertCreated()->json('data');
        $this->assertSame('Mine', $mine['title'], 'Another user\'s task is never returned');

        $this->postJson('/api/tasks', ['title' => 'Bad', 'client_id' => 'not-a-uuid'])->assertUnprocessable()->assertJsonValidationErrors('client_id');
        $this->patchJson('/api/tasks/'.$mine['id'], ['client_id' => (string) Str::uuid()])->assertUnprocessable()->assertJsonValidationErrors('client_id');
        $this->postJson('/api/tasks', ['title' => 'Without a device id'])->assertCreated();
        $this->postJson('/api/tasks', ['title' => 'Without a device id'])->assertCreated();
        $this->assertSame(3, Task::where('user_id', $user->id)->count());
    }
}
