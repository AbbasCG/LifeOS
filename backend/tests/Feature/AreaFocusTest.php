<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * V12: study and personal windows with optional daily limits, in the week planner, the day planner and Copilot.
 */
class AreaFocusTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private Category $study;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Monday 26 October 2026, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2026-10-26 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        $this->study = Category::factory()->create(['user_id' => $this->user->id, 'area' => 'study']);
    }

    /**
     * @param  array<string, mixed>  $extra
     */
    private function prefs(array $extra = []): void
    {
        UserSetting::updateOrCreate(['user_id' => $this->user->id], ['preferences' => $extra + ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'focus_block_minutes' => 60]]);
    }

    private function local(string $iso): CarbonImmutable
    {
        return CarbonImmutable::parse($iso)->setTimezone('Europe/Amsterdam');
    }

    private function between(string $iso, string $from, string $to): bool
    {
        $t = $this->local($iso)->format('H:i');

        return $t >= $from && $t <= $to;
    }

    private function send(string $message, ?string $conversation = null, array $extra = [], string $language = 'en'): TestResponse
    {
        return $this->actingAs($this->user)->postJson('/api/copilot/messages', ['message' => $message, 'language' => $language, 'conversation_id' => $conversation] + $extra)->assertOk();
    }

    public function test_week_plan_puts_study_tasks_in_study_hours_within_the_daily_limit(): void
    {
        $this->prefs(['study_start' => '19:00', 'study_end' => '21:00', 'study_daily_limit' => 60]);
        $exam = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Exam revision', 'category_id' => $this->study->id, 'estimated_minutes' => 120, 'priority' => 'high', 'actual_minutes' => 0, 'status' => 'todo', 'due_at' => null]);
        $report = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Report', 'estimated_minutes' => 60, 'priority' => 'medium', 'actual_minutes' => 0, 'status' => 'todo', 'due_at' => null]);

        $plan = $this->actingAs($this->user)->postJson('/api/plans', ['date' => '2026-10-26', 'days' => 3])->assertCreated()->json();
        $items = collect($plan['items']);
        $studyItems = $items->where('task_id', $exam->id)->values();
        $this->assertCount(2, $studyItems);
        foreach ($studyItems as $item) {
            $this->assertSame('study', $item['area']);
            $this->assertTrue($this->between($item['starts_at'], '19:00', '21:00') && $this->between($item['ends_at'], '19:00', '21:00'));
        }
        $this->assertSame(2, $studyItems->map(fn ($i) => $this->local($i['starts_at'])->toDateString())->unique()->count(), 'at most 60 study minutes per day');
        $work = $items->firstWhere('task_id', $report->id);
        $this->assertSame('work', $work['area']);
        $this->assertTrue($this->between($work['starts_at'], '09:00', '17:00'));
        $this->assertSame(0, collect($plan['summary']['days'])->firstWhere('date', '2026-10-26')['planned_minutes'] - ($this->local($work['starts_at'])->toDateString() === '2026-10-26' ? 60 : 0), 'study blocks do not count towards the work-day load');

        $this->postJson("/api/plans/{$plan['id']}/accept")->assertOk();
        $this->assertSame(3, CalendarEvent::count());
    }

    public function test_without_study_hours_study_tasks_keep_using_working_hours(): void
    {
        $this->prefs();
        $exam = Task::factory()->create(['user_id' => $this->user->id, 'category_id' => $this->study->id, 'estimated_minutes' => 60, 'actual_minutes' => 0, 'status' => 'todo', 'due_at' => null]);
        $plan = $this->actingAs($this->user)->postJson('/api/plans', ['date' => '2026-10-26', 'days' => 1])->assertCreated()->json();
        $item = collect($plan['items'])->firstWhere('task_id', $exam->id);
        $this->assertSame('work', $item['area']);
        $this->assertTrue($this->between($item['starts_at'], '09:00', '17:00'));
        $this->postJson("/api/plans/{$plan['id']}/accept")->assertOk();
    }

    public function test_day_plan_respects_the_study_limit_and_accepts_tasks_placed_in_working_hours(): void
    {
        $this->prefs(['study_start' => '19:00', 'study_end' => '21:00', 'study_daily_limit' => 30]);
        $exam = Task::factory()->create(['user_id' => $this->user->id, 'category_id' => $this->study->id, 'estimated_minutes' => 120, 'priority' => 'high', 'actual_minutes' => 0, 'status' => 'todo', 'due_at' => now()->addDay()]);
        $plan = $this->actingAs($this->user)->getJson('/api/day-plan?date=2026-10-26')->assertOk()->json();
        foreach ($plan['alternatives'] as $variant) {
            $this->assertLessThanOrEqual(30, collect($variant['items'])->where('task_id', $exam->id)->sum('minutes'), $variant['key']);
        }

        // No study window: the study task is planned in working hours and the chosen plan can be accepted.
        $this->prefs();
        $proposal = $this->postJson('/api/day-plan', ['date' => '2026-10-26', 'variant' => 'balanced'])->assertCreated()->json();
        $this->assertSame('work', $proposal['items'][0]['area']);
        $this->postJson("/api/plans/{$proposal['id']}/accept")->assertOk();
        $this->assertTrue(CalendarEvent::where('task_id', $exam->id)->exists());
    }

    public function test_copilot_finds_study_blocks_within_the_limit_and_switches_area(): void
    {
        $this->prefs(['study_start' => '19:00', 'study_end' => '21:00', 'study_daily_limit' => 60]);
        $exam = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Exam revision', 'category_id' => $this->study->id, 'estimated_minutes' => 300, 'actual_minutes' => 0, 'status' => 'todo', 'due_at' => null]);
        // Monday's study hour is already booked.
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $exam->id, 'title' => 'Revision', 'kind' => 'flexible', 'starts_at' => CarbonImmutable::parse('2026-10-26 19:00', 'Europe/Amsterdam')->utc(), 'ends_at' => CarbonImmutable::parse('2026-10-26 20:00', 'Europe/Amsterdam')->utc()]);

        $r = $this->send('Find two study blocks this week')->assertJsonPath('message.state.slots.area', 'study');
        $actions = collect($r->json('message.proposal.actions'));
        $this->assertCount(2, $actions);
        foreach ($actions as $a) {
            $this->assertStringStartsWith('Study: Exam revision', $a['title']);
            $this->assertTrue($this->between($a['starts_at'], '19:00', '21:00'));
            $this->assertNotSame('2026-10-26', $this->local($a['starts_at'])->toDateString(), 'Monday is at its study limit');
        }
        $this->assertContains('area:study', collect($r->json('message.plan.alternatives'))->pluck('key')->all());

        $work = $this->send('', $r->json('conversation.id'), ['choice' => ['type' => 'alternative', 'message_id' => $r->json('message.id'), 'value' => 'area:work']])
            ->assertJsonPath('user_message.content', 'In working hours')->assertJsonPath('message.state.slots.area', 'work');
        foreach ($work->json('message.proposal.actions') as $a) {
            $this->assertTrue($this->between($a['starts_at'], '09:00', '17:00'));
        }
        $this->send('use my study hours instead', $r->json('conversation.id'))->assertJsonPath('message.state.slots.area', 'study');
    }

    public function test_focus_without_a_window_falls_back_to_working_hours_and_says_so(): void
    {
        $this->prefs();
        $r = $this->send('Find two focus blocks for personal projects')->assertJsonPath('message.state.slots.area', 'personal');
        $this->assertSame('no_window', collect($r->json('message.plan.conflicts'))->last()['type']);
        foreach ($r->json('message.proposal.actions') as $a) {
            $this->assertTrue($this->between($a['starts_at'], '09:00', '17:00'));
        }
        $this->assertSame([], collect($r->json('message.plan.alternatives'))->filter(fn ($a) => str_starts_with($a['key'], 'area:'))->all(), 'no area switch without windows');

        $this->send('اعثر على فترتي تركيز للدراسة', null, [], 'ar')->assertJsonPath('message.state.slots.area', 'study')->assertJsonPath('message.intent', 'focus_blocks');
    }

    public function test_area_limits_are_validated_and_optional(): void
    {
        $this->prefs();
        $this->actingAs($this->user)->putJson('/api/settings', ['study_daily_limit' => 10])->assertUnprocessable();
        $this->putJson('/api/settings', ['personal_daily_limit' => 1000])->assertUnprocessable();
        $this->putJson('/api/settings', ['study_daily_limit' => 90, 'personal_daily_limit' => null])->assertOk();
        $this->getJson('/api/settings')->assertJsonPath('study_daily_limit', 90)->assertJsonPath('personal_daily_limit', null);
    }
}
