<?php

namespace Tests\Feature;

use App\Models\Conversation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/** Dutch is a language a person can choose; the product's own texts fall back to English, and the AI is asked to answer in Dutch. */
class DutchLanguageTest extends TestCase
{
    use RefreshDatabase;

    public function test_dutch_can_be_saved_as_the_language_and_unknown_languages_are_refused(): void
    {
        $this->actingAs(User::factory()->create());
        $this->putJson('/api/settings', ['language' => 'nl'])->assertOk()->assertJsonPath('language', 'nl');
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('language', 'nl');
        $this->putJson('/api/settings', ['language' => 'fr'])->assertUnprocessable();
        $this->putJson('/api/settings', ['language' => 'en'])->assertOk()->assertJsonPath('language', 'en');
    }

    public function test_the_assistant_and_copilot_accept_dutch_and_refuse_other_languages(): void
    {
        config(['ai.provider' => 'disabled']);
        $this->actingAs(User::factory()->create());
        $this->postJson('/api/assistant', ['message' => 'How was my week?', 'language' => 'nl'])->assertOk()->assertJsonPath('provider', 'local');
        $this->postJson('/api/assistant', ['message' => 'How was my week?', 'language' => 'fr'])->assertUnprocessable();
        $this->postJson('/api/copilot/messages', ['message' => 'Hoe was mijn week?', 'language' => 'nl'])->assertOk();
        $this->assertSame('nl', Conversation::first()->language);
        $this->postJson('/api/copilot/messages', ['message' => 'x', 'language' => 'fr'])->assertUnprocessable();
    }

    public function test_the_ai_provider_is_told_to_reply_in_dutch(): void
    {
        config(['ai.provider' => 'openai', 'ai.providers.openai.key' => 'test-key']);
        Http::fake(['api.openai.com/*' => Http::response(['choices' => [['message' => ['content' => json_encode(['message' => 'Probeer dit.', 'intent' => 'breakdown', 'schedule' => null, 'subtasks' => [['title' => 'Stap een', 'minutes' => 30]], 'query' => null, 'review' => null])]]]])]);
        $this->actingAs(User::factory()->create())->postJson('/api/assistant', ['message' => 'Help me', 'language' => 'nl'])->assertOk();
        Http::assertSent(fn ($request) => str_contains(json_encode($request->data()), 'Reply in Dutch'));
    }
}
