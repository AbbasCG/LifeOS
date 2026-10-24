<?php

namespace Tests\Feature;

use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class AssistantTest extends TestCase
{
    use RefreshDatabase;

    public function test_local_assistant_prioritizes_without_an_api_key(): void
    {
        config(['ai.provider' => 'disabled']);
        Http::fake();
        $user = User::factory()->create();
        Task::create(['user_id' => $user->id, 'title' => 'Write proposal', 'priority' => 'urgent']);
        Task::create(['user_id' => $user->id, 'title' => 'Water plants', 'priority' => 'low']);

        $this->actingAs($user)->postJson('/api/assistant', ['message' => 'What should I focus on today?', 'language' => 'en'])
            ->assertOk()
            ->assertJsonPath('provider', 'local')
            ->assertJsonPath('intent', 'plan')
            ->assertJsonPath('tasks.0.title', 'Write proposal');
        Http::assertNothingSent();
    }

    public function test_local_breakdown_uses_the_matching_task_estimate(): void
    {
        $user = User::factory()->create();
        Task::create(['user_id' => $user->id, 'title' => 'Thesis chapter', 'estimated_minutes' => 200]);

        $response = $this->actingAs($user)->postJson('/api/assistant', ['message' => 'Break down Thesis chapter', 'language' => 'en'])
            ->assertOk()
            ->assertJsonPath('intent', 'breakdown')
            ->assertJsonCount(5, 'subtasks')
            ->assertJsonPath('tasks.0.title', 'Thesis chapter');
        $this->assertEqualsWithDelta(200, array_sum(array_column($response->json('subtasks'), 'estimated_minutes')), 10);
    }

    public function test_local_assistant_answers_in_arabic(): void
    {
        $this->actingAs(User::factory()->create())->postJson('/api/assistant', ['message' => 'ما المهام المتأخرة؟', 'language' => 'ar'])
            ->assertOk()
            ->assertJsonPath('intent', 'overdue')
            ->assertJsonPath('message', 'لا توجد مهام متأخرة. أحسنت!');
    }

    public function test_assistant_never_reads_other_users_tasks(): void
    {
        Task::create(['user_id' => User::factory()->create()->id, 'title' => 'Secret plan', 'priority' => 'urgent']);

        $response = $this->actingAs(User::factory()->create())->postJson('/api/assistant', ['message' => 'plan my day', 'language' => 'en'])->assertOk();

        $this->assertStringNotContainsString('Secret plan', $response->getContent());
    }

    public function test_provider_failure_falls_back_to_the_local_assistant(): void
    {
        config(['ai.provider' => 'openai', 'ai.providers.openai.key' => 'test-key']);
        Http::fake(['api.openai.com/*' => Http::response(['error' => 'down'], 500)]);

        $this->actingAs(User::factory()->create())->postJson('/api/assistant', ['message' => 'How was my week?', 'language' => 'en'])
            ->assertOk()
            ->assertJsonPath('provider', 'local')
            ->assertJsonPath('intent', 'review')
            ->assertJsonStructure(['notice']);
    }

    public function test_valid_provider_response_is_returned(): void
    {
        config(['ai.provider' => 'openai', 'ai.providers.openai.key' => 'test-key']);
        Http::fake(['api.openai.com/*' => Http::response(['choices' => [['message' => ['content' => json_encode(['message' => 'Try this.', 'intent' => 'breakdown', 'schedule' => null, 'subtasks' => [['title' => 'Outline', 'estimated_minutes' => 30]]])]]]])]);

        $this->actingAs(User::factory()->create())->postJson('/api/assistant', ['message' => 'Help', 'language' => 'en'])
            ->assertOk()
            ->assertJsonPath('provider', 'openai')
            ->assertJsonPath('subtasks.0.title', 'Outline');
    }

    public function test_general_api_traffic_does_not_consume_the_assistant_limit(): void
    {
        $this->actingAs(User::factory()->create());
        for ($i = 0; $i < 15; $i++) {
            $this->getJson('/api/tasks')->assertOk();
        }
        for ($i = 0; $i < 10; $i++) {
            $this->postJson('/api/assistant', ['message' => 'help', 'language' => 'en'])->assertOk();
        }
        $this->postJson('/api/assistant', ['message' => 'help', 'language' => 'en'])->assertTooManyRequests();
        $this->getJson('/api/tasks')->assertOk();
    }

    public function test_input_is_validated(): void
    {
        $this->actingAs(User::factory()->create())->postJson('/api/assistant', ['message' => '', 'language' => 'fr'])->assertUnprocessable();
    }
}
