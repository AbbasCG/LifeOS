<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TodayLayoutTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_top_of_today_is_saved_separately_for_phone_and_desktop(): void
    {
        $user = User::factory()->create();
        $layout = [
            'phone' => ['order' => ['now', 'habits', 'top3', 'strip', 'progress', 'copilot', 'suggestions'], 'hidden' => ['copilot', 'suggestions']],
            'desktop' => ['order' => ['strip', 'now', 'top3', 'progress', 'habits', 'copilot', 'suggestions'], 'hidden' => []],
        ];

        $this->actingAs($user)->putJson('/api/settings', ['today_layout' => $layout])->assertOk()->assertJsonPath('today_layout.phone.hidden', ['copilot', 'suggestions']);
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('today_layout', $layout);

        // Resetting one device keeps the other.
        $this->putJson('/api/settings', ['today_layout' => ['desktop' => $layout['desktop']]])->assertOk();
        $this->getJson('/api/settings')->assertJsonPath('today_layout', ['desktop' => $layout['desktop']]);
    }

    public function test_the_quick_check_in_section_can_be_placed_and_hidden_and_saving_only_energy_keeps_the_rest(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user);

        $layout = ['phone' => ['order' => ['now', 'checkin', 'strip'], 'hidden' => ['checkin']]];
        $this->putJson('/api/settings', ['today_layout' => $layout])->assertOk()->assertJsonPath('today_layout.phone.hidden', ['checkin']);

        // The one-tap check-in sends only the energy; what was already saved for the day stays.
        $day = now($user->timezone())->toDateString();
        $this->putJson("/api/checkins/{$day}", ['mood' => 4, 'sleep_minutes' => 420, 'reflection' => 'Slept well'])->assertCreated();
        $this->putJson("/api/checkins/{$day}", ['energy' => 5])->assertOk()
            ->assertJsonPath('energy', 5)->assertJsonPath('mood', 4)->assertJsonPath('sleep_minutes', 420)->assertJsonPath('reflection', 'Slept well');
    }

    public function test_the_now_card_cannot_be_hidden_and_sections_are_validated(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user);

        $this->putJson('/api/settings', ['today_layout' => ['phone' => ['hidden' => ['now']]]])->assertUnprocessable()->assertJsonValidationErrors('today_layout.phone.hidden.0');
        $this->putJson('/api/settings', ['today_layout' => ['phone' => ['order' => ['now', 'weather']]]])->assertUnprocessable()->assertJsonValidationErrors('today_layout.phone.order.1');
        $this->putJson('/api/settings', ['today_layout' => ['phone' => ['order' => ['now', 'now']]]])->assertUnprocessable();
        $this->putJson('/api/settings', ['today_layout' => ['tablet' => ['order' => ['now']]]])->assertUnprocessable()->assertJsonValidationErrors('today_layout');
        $this->putJson('/api/settings', ['today_layout' => ['phone' => ['order' => ['now'], 'color' => 'red']]])->assertUnprocessable();
        $this->assertArrayNotHasKey('today_layout', $user->fresh()->preferences());
    }
}
