<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TodayTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5], 'break_minutes' => 10, 'daily_focus_limit' => 120]]);
    }

    public function test_morning_briefing_slots_deadlines_and_progress_come_from_real_data(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-03-10 08:00', 'UTC'));
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Client call', 'kind' => 'fixed', 'starts_at' => '2027-03-10 10:00:00', 'ends_at' => '2027-03-10 11:00:00']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Send invoice', 'priority' => 'urgent', 'due_at' => '2027-03-10 16:00:00']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Late report', 'priority' => 'high', 'due_at' => '2027-03-08 16:00:00']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Done early', 'status' => 'completed', 'completed_at' => '2027-03-10 07:30:00']);
        Project::create(['user_id' => $this->user->id, 'title' => 'Website', 'status' => 'active', 'due_at' => '2027-03-12 17:00:00']);
        FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 1800, 'elapsed_seconds' => 1800, 'completed_at' => '2027-03-10 07:45:00']);
        $habit = Habit::create(['user_id' => $this->user->id, 'title' => 'Read', 'recurrence' => 'daily']);
        HabitEntry::create(['habit_id' => $habit->id, 'date' => '2027-03-10']);
        Habit::create(['user_id' => $this->user->id, 'title' => 'Stretch', 'recurrence' => 'daily']);

        $today = $this->actingAs($this->user)->getJson('/api/today')->assertOk();

        $this->assertSame('morning', $today->json('period'));
        $this->assertSame(['09:00–10:00', '11:10–17:00'], collect($today->json('focus_time.slots'))->map(fn ($s) => CarbonImmutable::parse($s['starts_at'])->format('H:i').'–'.CarbonImmutable::parse($s['ends_at'])->format('H:i'))->all());
        $this->assertSame(410, $today->json('focus_time.free_minutes'), 'a 10-minute break follows the call');
        $this->assertSame(['Late report', 'Send invoice', 'Website'], array_column($today->json('deadlines'), 'title'));
        $this->assertSame(['overdue', 'today', 'week'], array_column($today->json('deadlines'), 'bucket'));
        $this->assertSame(['done' => 1, 'target' => 3], $today->json('progress.tasks'));
        $this->assertSame(['done' => 30, 'target' => 120], $today->json('progress.focus'));
        $this->assertSame(['done' => 1, 'target' => 2], $today->json('progress.habits'));
        $briefing = collect($today->json('briefing'))->pluck('en')->implode(' ');
        $this->assertStringContainsString('next: “Client call” at 10:00', $briefing);
        $this->assertStringContainsString('Top priority', $briefing);
        $this->assertStringContainsString('Check in on your energy', $briefing);
        $this->assertNull($today->json('reflection_prompt'));
        // Day dial data: today's commitments with their source, and the work window.
        $this->assertSame([['title' => 'Client call', 'kind' => 'fixed', 'source' => 'lifeos']], collect($today->json('timeline'))->map(fn ($o) => array_intersect_key($o, array_flip(['title', 'kind', 'source'])))->all());
        $this->assertSame('09:00', CarbonImmutable::parse($today->json('windows.work.start'))->format('H:i'));
    }

    public function test_evening_summary_and_energy_indicator(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-03-10 17:45', 'UTC'));
        Task::create(['user_id' => $this->user->id, 'title' => 'Open today', 'due_at' => '2027-03-10 20:00:00']);
        Task::create(['user_id' => $this->user->id, 'title' => 'Finished', 'status' => 'completed', 'completed_at' => '2027-03-10 15:00:00']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Gym', 'starts_at' => '2027-03-11 07:00:00', 'ends_at' => '2027-03-11 08:00:00']);
        DailyCheckin::create(['user_id' => $this->user->id, 'date' => '2027-03-10', 'energy' => 2, 'workload' => 5]);

        $today = $this->actingAs($this->user)->getJson('/api/today')->assertOk();

        $this->assertSame('evening', $today->json('period'));
        $lines = collect($today->json('briefing'))->pluck('en')->implode(' ');
        $this->assertStringContainsString('You completed 1 task(s)', $lines);
        $this->assertStringContainsString('1 task(s) due today are still open', $lines);
        $this->assertStringContainsString('Tomorrow starts with “Gym” at 07:00', $lines);
        $this->assertNotNull($today->json('reflection_prompt'));
        $this->assertSame('heavy', $today->json('energy.level'));
        $this->assertSame(2, $today->json('energy.energy'));
    }

    public function test_today_is_private_and_new_widgets_are_accepted_in_the_layout(): void
    {
        Task::create(['user_id' => User::factory()->create()->id, 'title' => 'Someone else', 'priority' => 'urgent', 'due_at' => now()->addHour()]);

        $this->assertStringNotContainsString('Someone else', $this->actingAs($this->user)->getJson('/api/today')->assertOk()->getContent());
        $this->putJson('/api/settings', ['dashboard' => ['order' => ['today', 'progress', 'checkin', 'deadlines', 'focus_time', 'actions'], 'hidden' => []]])->assertOk();
    }
}
