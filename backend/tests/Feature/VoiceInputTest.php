<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * V17: the account switch for dictation in Copilot (the dictation itself runs in the browser).
 */
class VoiceInputTest extends TestCase
{
    use RefreshDatabase;

    public function test_voice_input_is_allowed_by_default_and_can_be_switched_off(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user)->getJson('/api/assistant/status')->assertOk()->assertJsonPath('voice_allowed', true);
        $this->getJson('/api/intelligence/settings')->assertOk()->assertJsonPath('external_ai.voice', true);

        $this->putJson('/api/settings', ['voice_input' => false])->assertOk()->assertJsonPath('voice_input', false);
        $this->getJson('/api/assistant/status')->assertJsonPath('voice_allowed', false);
        $this->getJson('/api/intelligence/settings')->assertJsonPath('external_ai.voice', false);

        $this->putJson('/api/settings', ['voice_input' => 'loud'])->assertUnprocessable();
    }

    public function test_the_switch_is_per_account(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user)->putJson('/api/settings', ['voice_input' => false])->assertOk();
        $this->actingAs(User::factory()->create())->getJson('/api/assistant/status')->assertJsonPath('voice_allowed', true);
    }
}
