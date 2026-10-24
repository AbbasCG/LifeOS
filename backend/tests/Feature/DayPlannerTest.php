<?php

namespace Tests\Feature;

use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\DailyCheckin;
use App\Models\ExternalEvent;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DayPlannerTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Wednesday 07:00 UTC; the user works 09:00–17:00 UTC, Mon–Fri.
        $this->travelTo(CarbonImmutable::parse('2027-03-10 07:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'focus_block_minutes' => 60, 'buffer_minutes' => 15]]);
    }

    private function at(string $time, int $day = 0): CarbonImmutable
    {
        return CarbonImmutable::parse('2027-03-10 '.$time, 'UTC')->addDays($day);
    }

    private function plan(array $query = []): array
    {
        return $this->actingAs($this->user)->getJson('/api/day-plan?'.http_build_query($query))->assertOk()->json();
    }

    public function test_budget_respects_commitments_buffers_recurring_and_imported_events(): void
    {
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Stand-up', 'kind' => 'fixed', 'timezone' => 'UTC', 'starts_at' => $this->at('09:30', -7), 'ends_at' => $this->at('10:00', -7), 'recurrence' => ['freq' => 'daily', 'interval' => 1]]);
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g1', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'external_id' => 'e1', 'title' => 'Client call', 'starts_at' => $this->at('14:00'), 'ends_at' => $this->at('15:00'), 'all_day' => false]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Report', 'priority' => 'high', 'estimated_minutes' => 120, 'due_at' => $this->at('16:00', 1)]);

        $plan = $this->plan();

        $this->assertSame(480, $plan['budget']['window_minutes']);
        $this->assertSame(90, $plan['budget']['committed_minutes']);
        // 480 − (30 + 2×15 buffer) − (60 + 2×15 buffer) = 330
        $this->assertSame(330, $plan['budget']['free_minutes']);
        $this->assertEqualsCanonicalizing(['Stand-up', 'Client call'], array_column($plan['commitments'], 'title'));
        $items = $plan['alternatives'][0]['items'];
        $this->assertNotEmpty($items);
        foreach ($items as $item) {
            $s = CarbonImmutable::parse($item['starts_at']);
            $e = CarbonImmutable::parse($item['ends_at']);
            $this->assertFalse($s < $this->at('10:15') && $e > $this->at('09:15'), 'respects the stand-up and its buffer');
            $this->assertFalse($s < $this->at('15:15') && $e > $this->at('13:45'), 'respects the imported call and its buffer');
            $this->assertNotEmpty($item['explanation']['en']);
        }
        $this->assertSame(0, ScheduleProposal::count(), 'viewing a plan saves nothing');
    }

    public function test_study_boundary_low_energy_and_estimate_accuracy(): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->preferences(), ['study_start' => '19:00', 'study_end' => '21:00'])]);
        $study = Category::create(['user_id' => $this->user->id, 'title' => 'Study', 'area' => 'study']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Statistics module', 'category_id' => $study->id, 'priority' => 'high', 'estimated_minutes' => 60, 'due_at' => $this->at('23:00')]);
        foreach (range(1, 5) as $i) {
            Task::create(['user_id' => $this->user->id, 'title' => "Done {$i}", 'status' => 'completed', 'completed_at' => now()->subDays($i), 'estimated_minutes' => 60, 'actual_minutes' => 75]);
        }
        DailyCheckin::create(['user_id' => $this->user->id, 'date' => '2027-03-10', 'energy' => 2]);

        $plan = $this->plan();

        $this->assertSame(1.25, $plan['estimate_ratio']);
        $this->assertSame(2, $plan['energy']);
        $this->assertSame('light', $plan['recommended']);
        $this->assertSame((int) floor($plan['budget']['free_minutes'] * 0.7), $plan['budget']['capacity_minutes']);
        $item = collect($plan['alternatives'][0]['items'])->firstWhere('title', 'Statistics module');
        $this->assertSame('study', $item['area']);
        $this->assertGreaterThanOrEqual('19:00', CarbonImmutable::parse($item['starts_at'])->format('H:i'));
        $this->assertSame(75, collect($plan['alternatives'][0]['items'])->where('title', 'Statistics module')->sum('minutes'), '60 min × 1.25');
        $this->assertTrue(collect($plan['explanation'])->contains(fn ($e) => str_contains($e['en'], '1.25×')));
    }

    public function test_overload_recovery_and_alternatives(): void
    {
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Workshop', 'kind' => 'fixed', 'starts_at' => $this->at('09:00'), 'ends_at' => $this->at('15:00')]);
        $missed = Task::create(['user_id' => $this->user->id, 'title' => 'Missed task', 'estimated_minutes' => 60]);
        CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $missed->id, 'title' => 'Missed task', 'kind' => 'flexible', 'starts_at' => $this->at('10:00', -1), 'ends_at' => $this->at('11:00', -1)]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Big urgent', 'priority' => 'urgent', 'estimated_minutes' => 240, 'due_at' => $this->at('17:00', 1)]);

        $plan = $this->plan();

        $this->assertNotNull($plan['overload']);
        $this->assertSame(['Missed task'], array_column($plan['recovery'], 'title'));
        $this->assertSame(['balanced', 'deep', 'light'], array_column($plan['alternatives'], 'key'));
        $balanced = $plan['alternatives'][0];
        $this->assertContains('rescheduled', collect($balanced['items'])->firstWhere('title', 'Missed task')['reasons']);
        $this->assertNotEmpty($balanced['warnings'], 'must-do work that does not fit is reported');
        $this->assertLessThanOrEqual((int) floor($plan['budget']['capacity_minutes'] * 0.6), $plan['alternatives'][2]['metrics']['planned_minutes']);
    }

    public function test_choosing_creates_a_pending_proposal_that_only_changes_the_calendar_when_accepted(): void
    {
        UserSetting::where('user_id', $this->user->id)->update(['preferences' => array_replace($this->user->preferences(), ['personal_start' => '18:00', 'personal_end' => '20:00'])]);
        $personal = Category::create(['user_id' => $this->user->id, 'title' => 'Home', 'area' => 'personal']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Write proposal', 'priority' => 'high', 'estimated_minutes' => 90, 'due_at' => $this->at('17:00', 2)]);
        Task::create(['user_id' => $this->user->id, 'title' => 'Fix tap', 'category_id' => $personal->id, 'priority' => 'high', 'estimated_minutes' => 45, 'due_at' => $this->at('22:00')]);

        $proposal = $this->actingAs($this->user)->postJson('/api/day-plan', ['variant' => 'balanced'])->assertCreated()->assertJsonPath('status', 'pending')->json();
        $this->assertSame(0, CalendarEvent::count());
        $this->assertSame('balanced', $proposal['summary']['variant']);

        $this->postJson("/api/plans/{$proposal['id']}/accept")->assertOk();
        $titles = CalendarEvent::orderBy('starts_at')->get()->map(fn ($e) => $e->title.' '.$e->starts_at->format('H:i'))->all();
        $this->assertContains('Fix tap 18:00', $titles, 'personal tasks land in the personal window and pass accept');
        $this->assertTrue(collect($titles)->contains(fn ($t) => str_starts_with($t, 'Write proposal')));

        $this->postJson('/api/day-plan', ['variant' => 'nonsense'])->assertUnprocessable();
        $this->getJson('/api/day-plan?date=2027-03-01')->assertUnprocessable();
    }

    public function test_plans_are_private(): void
    {
        Task::create(['user_id' => User::factory()->create()->id, 'title' => 'Not yours', 'priority' => 'urgent', 'estimated_minutes' => 60]);

        $this->assertStringNotContainsString('Not yours', json_encode($this->plan()));
    }
}
