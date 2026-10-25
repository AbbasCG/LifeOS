<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\CalendarEvent;
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
 * V15: plan learning that weighs recent choices more and learns per situation (workday or day off; light, normal or
 * busy period).
 */
class SmarterLearningTest extends TestCase
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

    private function recordTimes(int $times, string $dimension, string $value, array $context = []): void
    {
        foreach (range(1, $times) as $i) {
            PlanLearning::record($this->user, $dimension, $value, $context);
        }
    }

    /** Book the working hours of the next seven days (a busy week). */
    private function bookWeek(): void
    {
        foreach (range(0, 6) as $d) {
            $day = CarbonImmutable::parse('2026-10-26', 'Europe/Amsterdam')->addDays($d);
            CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'kind' => 'fixed', 'starts_at' => $day->setTime(9, 0)->utc(), 'ends_at' => $day->setTime(16, 0)->utc()]);
        }
    }

    public function test_recent_choices_count_more_and_old_ones_are_forgotten(): void
    {
        $this->recordTimes(3, 'week_version', 'essentials');
        $this->assertSame('essentials', PlanLearning::preferred($this->user, 'week_version')['value']);

        // Four months later the habit changed: two new choices are not enough yet, the third is.
        $this->travel(120)->days();
        $this->recordTimes(2, 'week_version', 'balanced');
        $this->assertNull(PlanLearning::preferred($this->user, 'week_version'), 'two recent choices are not enough');
        $this->recordTimes(1, 'week_version', 'balanced');
        $this->assertSame(['value' => 'balanced', 'scope' => null], PlanLearning::preferred($this->user, 'week_version'), '3 equal counts, but the recent ones weigh more');
        $summary = $this->actingAs($this->user)->getJson('/api/intelligence/settings')->assertOk()
            ->assertJsonPath('learning.thresholds.half_life_days', 30)->assertJsonPath('learning.thresholds.max_age_days', 180)->json('learning.dimensions.0');
        $this->assertSame(['essentials' => 3, 'balanced' => 3], $summary['counts']);
        $this->assertSame(['essentials' => 6, 'balanced' => 94], $summary['shares']);

        // After six months the old choices are dropped entirely.
        $this->travel(70)->days();
        $this->assertSame(['balanced' => 3], PlanLearning::counts($this->user)['week_version']);
    }

    public function test_day_strategy_is_learned_separately_for_workdays_and_days_off(): void
    {
        $this->recordTimes(3, 'day_strategy', 'deep', ['day' => 'workday']);
        $this->recordTimes(3, 'day_strategy', 'light', ['day' => 'day_off']);
        $this->assertNull(PlanLearning::preferred($this->user, 'day_strategy'), 'overall there is no clear preference');

        $this->send('Reorganize today')->assertJsonPath('message.state.slots.variant', 'deep')
            ->assertJsonPath('message.plan.learned_context.day_strategy', 'workday')->assertJsonPath('message.state.learning_context.day', 'workday');

        // Saturday: a day off.
        $this->travelTo(CarbonImmutable::parse('2026-10-31 09:00', 'Europe/Amsterdam'));
        $r = $this->send('Reorganize today')->assertJsonPath('message.state.slots.variant', 'light')->assertJsonPath('message.plan.learned_context.day_strategy', 'day_off');
        $this->assertStringContainsString('a light day (on days off)', implode(' ', $r->json('message.plan.explanation')));

        // A choice made on that plan is recorded for days off.
        $this->send('', $r->json('conversation.id'), ['choice' => ['type' => 'alternative', 'message_id' => $r->json('message.id'), 'value' => 'balanced']]);
        $last = collect(PlanLearning::observations($this->user))->last();
        $this->assertSame(['d' => 'day_strategy', 'v' => 'balanced', 'day' => 'day_off'], array_intersect_key($last, array_flip(['d', 'v', 'day'])));
    }

    public function test_week_versions_are_learned_for_busy_weeks(): void
    {
        $this->recordTimes(3, 'week_version', 'essentials', ['load' => 'heavy']);
        $this->recordTimes(3, 'week_version', 'balanced', ['load' => 'light']);

        $light = $this->send('Plan my week')->assertJsonPath('message.state.learning_context.load', 'light')->assertJsonPath('message.plan.learned_context.week_version', 'light');
        $light->assertJsonPath('message.state.slots.alternative', 'balanced');

        $this->bookWeek();
        $busy = $this->send('Plan my week')->assertJsonPath('message.state.learning_context.load', 'heavy')->assertJsonPath('message.state.slots.alternative', 'essentials');
        $this->assertStringContainsString('essentials only (in busy weeks)', implode(' ', $busy->json('message.plan.explanation')));
        // Picking another version still wins over the situation.
        $this->send('', $busy->json('conversation.id'), ['choice' => ['type' => 'alternative', 'message_id' => $busy->json('message.id'), 'value' => 'balanced']])
            ->assertJsonPath('message.state.slots.alternative', 'balanced')->assertJsonMissingPath('message.plan.learned.week_version');

        $summary = collect($this->getJson('/api/intelligence/settings')->json('learning.dimensions'))->firstWhere('dimension', 'week_version');
        $this->assertNull($summary['preferred']);
        $this->assertSame([['scope' => 'light', 'preferred' => 'balanced'], ['scope' => 'heavy', 'preferred' => 'essentials']], $summary['contexts']);
    }

    public function test_situations_are_not_computed_or_stored_while_learning_is_off(): void
    {
        IntelligenceSettings::save($this->user, ['features' => ['plan_learning' => false]]);
        $this->send('Plan my week')->assertJsonMissingPath('message.state.learning_context')->assertJsonMissingPath('message.plan.learned_context');
        $this->assertSame([], PlanLearning::context($this->user, 'plan_week', []));
    }

    public function test_counts_learned_before_v15_still_work_and_are_converted(): void
    {
        $setting = UserSetting::where('user_id', $this->user->id)->first();
        $setting->update(['preferences' => ['plan_learning' => ['week_version' => ['essentials' => 3, 'balanced' => 1], 'moves' => ['off' => 2]]] + $setting->preferences]);
        $this->assertSame('essentials', PlanLearning::preferred($this->user, 'week_version')['value']);
        $this->assertSame(['week_version' => ['balanced' => 1, 'essentials' => 3], 'moves' => ['off' => 2]], PlanLearning::counts($this->user));

        PlanLearning::record($this->user, 'moves', 'off', ['load' => 'normal']);
        $stored = UserSetting::where('user_id', $this->user->id)->value('preferences')['plan_learning'];
        $this->assertSame(['observations'], array_keys($stored));
        $this->assertCount(7, $stored['observations']);
        $this->assertSame(['d' => 'moves', 'v' => 'off', 'at' => '2026-10-26', 'load' => 'normal'], end($stored['observations']));
    }

    public function test_one_choice_can_be_forgotten_on_its_own(): void
    {
        $this->recordTimes(3, 'week_version', 'essentials');
        $this->recordTimes(2, 'moves', 'off');
        $this->actingAs($this->user)->deleteJson('/api/intelligence/learning?dimension=moves')->assertOk()->assertJsonPath('cleared', 2);
        $this->assertSame(['week_version' => ['essentials' => 3]], PlanLearning::counts($this->user));
        $this->assertSame(['deleted' => 2, 'dimension' => 'moves'], AuditLog::where('action', 'plan_learning_reset')->latest('id')->first()->meta);

        $this->deleteJson('/api/intelligence/learning?dimension=sideways')->assertUnprocessable();
        $this->deleteJson('/api/intelligence/learning')->assertOk()->assertJsonPath('cleared', 3);
        $this->assertSame([], PlanLearning::counts($this->user));
    }
}
