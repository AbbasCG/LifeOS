<?php

namespace Tests\Feature;

use App\Models\DailyCheckin;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\IntelligenceSettings;
use App\Services\PlanLearning;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * V19: plan learning that also tells low-, normal- and high-energy days apart, from today's check-in.
 */
class EnergyLearningTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled', 'ai.requests_per_minute' => 1000]);
        // Monday 26 October 2026, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-10-26 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10]]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Thesis', 'estimated_minutes' => 600, 'priority' => 'high', 'status' => 'todo', 'due_at' => null]);
        IntelligenceSettings::save($this->user, ['features' => ['plan_learning' => true]]);
    }

    private function send(string $message, ?string $conversation = null, array $extra = []): TestResponse
    {
        return $this->actingAs($this->user)->postJson('/api/copilot/messages', ['message' => $message, 'language' => 'en', 'conversation_id' => $conversation] + $extra)->assertOk();
    }

    private function energy(int $level): void
    {
        DailyCheckin::updateOrCreate(['user_id' => $this->user->id, 'date' => CarbonImmutable::now('Europe/Amsterdam')->toDateString()], ['energy' => $level]);
    }

    public function test_the_situation_includes_todays_energy_only_for_plans_starting_today(): void
    {
        $this->assertArrayNotHasKey('energy', PlanLearning::context($this->user, 'plan_week', []), 'no check-in yet');
        $this->energy(2);
        $this->assertSame('low', PlanLearning::context($this->user, 'reorganize_day', ['date' => '2026-10-26'])['energy']);
        $this->assertSame('low', PlanLearning::context($this->user, 'plan_week', [])['energy']);
        $this->assertArrayNotHasKey('energy', PlanLearning::context($this->user, 'plan_week', ['next_week' => true]), 'next week: today’s energy says nothing');
        $this->assertArrayNotHasKey('energy', PlanLearning::context($this->user, 'focus_blocks', ['within' => 'tomorrow']));
        $this->energy(3);
        $this->assertSame('normal', PlanLearning::context($this->user, 'focus_blocks', ['within' => 'today'])['energy']);
        $this->energy(5);
        $this->assertSame('high', PlanLearning::context($this->user, 'focus_blocks', ['within' => 'week'])['energy']);

        // Check-ins switched off, or not readable by the intelligence: no energy.
        IntelligenceSettings::save($this->user, ['sources' => ['checkins' => false]]);
        $this->assertArrayNotHasKey('energy', PlanLearning::context($this->user, 'plan_week', []));
        IntelligenceSettings::save($this->user, ['sources' => ['checkins' => true]]);
        $this->actingAs($this->user)->putJson('/api/settings', ['checkins_enabled' => false])->assertOk();
        $this->assertArrayNotHasKey('energy', PlanLearning::context($this->user, 'plan_week', []));
    }

    public function test_choices_are_learned_per_energy_and_energy_is_tried_first(): void
    {
        // Low-energy mornings: always the light day; high-energy mornings: deep focus first. Both on workdays.
        foreach ([[2, 'light'], [1, 'light'], [2, 'light'], [5, 'deep'], [4, 'deep'], [5, 'deep']] as [$level, $variant]) {
            $this->energy($level);
            $r = $this->send('Reorganize today');
            $this->assertSame($level <= 2 ? 'low' : 'high', $r->json('message.state.learning_context.energy'));
            $this->send('', $r->json('conversation.id'), ['choice' => ['type' => 'alternative', 'message_id' => $r->json('message.id'), 'value' => $variant]]);
        }
        $this->assertNull(PlanLearning::preferred($this->user, 'day_strategy', ['day' => 'workday']), 'by kind of day alone it is a tie');

        $this->energy(1);
        $low = $this->send('Reorganize today')->assertJsonPath('message.state.slots.variant', 'light')->assertJsonPath('message.plan.learned_context.day_strategy', 'low_energy');
        $this->assertStringContainsString('a light day (when your energy is low)', implode(' ', $low->json('message.plan.explanation')));
        $this->energy(5);
        $this->send('Reorganize today')->assertJsonPath('message.state.slots.variant', 'deep')->assertJsonPath('message.plan.learned_context.day_strategy', 'high_energy');
        $this->energy(3);
        $this->send('Reorganize today')->assertJsonMissingPath('message.plan.learned.day_strategy');

        $summary = collect($this->getJson('/api/intelligence/settings')->json('learning.dimensions'))->firstWhere('dimension', 'day_strategy');
        $this->assertSame([['scope' => 'low_energy', 'preferred' => 'light'], ['scope' => 'high_energy', 'preferred' => 'deep']], $summary['contexts']);
    }

    public function test_arabic_explanation_names_the_energy(): void
    {
        foreach (range(1, 3) as $i) {
            PlanLearning::record($this->user, 'week_version', 'essentials', ['energy' => 'low']);
        }
        PlanLearning::record($this->user, 'week_version', 'balanced', ['energy' => 'bogus']);
        $this->assertArrayNotHasKey('energy', collect(PlanLearning::observations($this->user))->last(), 'unknown situations are not stored');
        $this->energy(2);
        $r = $this->actingAs($this->user)->postJson('/api/copilot/messages', ['message' => 'خطط أسبوعي', 'language' => 'ar'])->assertOk()
            ->assertJsonPath('message.state.slots.alternative', 'essentials');
        $this->assertStringContainsString('الأساسيات فقط (عندما تكون طاقتك منخفضة)', implode(' ', $r->json('message.plan.explanation')));
    }
}
