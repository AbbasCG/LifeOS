<?php

namespace Tests\Feature;

use App\Demo\DemoMode;
use App\Models\AssistantProposal;
use App\Models\AutomationRule;
use App\Models\AutomationRun;
use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\InboxNotification;
use App\Models\Project;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Models\WeeklyReview;
use App\Services\AnalyticsService;
use App\Services\CalendarService;
use App\Services\HabitStreaks;
use App\Services\PlanningService;
use Carbon\CarbonImmutable;
use Database\Seeders\LifeOSDemoSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class DemoSeederTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        // Wednesday 14:00 Amsterdam time: a normal weekday mid-afternoon.
        $this->travelTo(CarbonImmutable::parse('2027-03-10 14:00', 'Europe/Amsterdam'));
        config(['demo.enabled' => true, 'demo.email' => 'demo@lifeos.local', 'demo.timezone' => 'Europe/Amsterdam', 'demo.password' => null]);
    }

    private function seedDemo(string $language = 'en', ?string $password = 'demo-password-123'): LifeOSDemoSeeder
    {
        $seeder = new LifeOSDemoSeeder;
        $seeder->language = $language;
        $seeder->password = $password;
        $seeder->setContainer($this->app)->__invoke();

        return $seeder;
    }

    private function demo(): User
    {
        return User::where('email', 'demo@lifeos.local')->sole();
    }

    public function test_refuses_to_run_unless_explicitly_enabled_outside_production(): void
    {
        config(['demo.enabled' => false]);
        $this->artisan('lifeos:demo')->assertFailed();
        $this->assertSame(0, User::count());

        config(['demo.enabled' => true]);
        $this->app['env'] = 'production';
        $this->artisan('lifeos:demo')->assertFailed();
        $this->expectException(\RuntimeException::class);
        $this->seedDemo();
    }

    public function test_covers_the_requested_volume_and_relationships(): void
    {
        $this->seedDemo();
        $id = $this->demo()->id;

        $tasks = Task::where('user_id', $id)->get();
        $this->assertTrue($tasks->count() >= 60 && $tasks->count() <= 100, "tasks: {$tasks->count()}");
        foreach (['completed', 'in_progress', 'todo', 'inbox', 'cancelled'] as $status) {
            $this->assertGreaterThan(0, $tasks->where('status', $status)->count(), $status);
        }
        $this->assertGreaterThanOrEqual(4, $tasks->filter(fn (Task $t) => ! in_array($t->status, ['completed', 'cancelled'], true) && $t->due_at?->isPast())->count(), 'overdue');
        $this->assertGreaterThanOrEqual(10, $tasks->filter(fn (Task $t) => $t->status !== 'completed' && $t->due_at?->isFuture())->count(), 'upcoming');
        $this->assertGreaterThanOrEqual(3, $tasks->whereNotNull('recurrence')->count());
        $this->assertGreaterThan(20, $tasks->whereNotNull('goal_id')->count());
        $this->assertGreaterThan(40, $tasks->whereNotNull('project_id')->count());
        $this->assertGreaterThan(20, $tasks->where('actual_minutes', '>', 0)->count());

        $this->assertTrue(Project::where('user_id', $id)->count() >= 6 && Project::where('user_id', $id)->count() <= 10);
        $this->assertNotEmpty(Project::where('user_id', $id)->first()->milestones);
        $this->assertTrue(Goal::where('user_id', $id)->count() >= 8 && Goal::where('user_id', $id)->count() <= 12);
        $habits = Habit::where('user_id', $id)->get();
        $this->assertTrue($habits->count() >= 8 && $habits->count() <= 12);
        $this->assertEqualsCanonicalizing(['daily', 'weekly'], $habits->pluck('recurrence')->unique()->values()->all());
        $this->assertGreaterThan(200, DB::table('habit_entries')->whereIn('habit_id', $habits->pluck('id'))->count());

        $events = CalendarEvent::where('user_id', $id)->get();
        $span = $events->whereNull('recurrence')->min('starts_at')->diffInDays($events->whereNull('recurrence')->max('starts_at'));
        $this->assertGreaterThanOrEqual(30, $span);
        $this->assertGreaterThanOrEqual(5, $events->whereNotNull('recurrence')->count());
        $this->assertEqualsCanonicalizing(['fixed', 'flexible'], $events->pluck('kind')->unique()->values()->all());
        $this->assertGreaterThan(5, $events->whereNotNull('task_id')->count());

        $sessions = FocusSession::where('user_id', $id)->get();
        $this->assertGreaterThan(40, $sessions->count());
        $this->assertGreaterThanOrEqual(30, $sessions->min('created_at')->diffInDays(now()));
        $this->assertTrue($sessions->contains('status', 'cancelled') && $sessions->contains('kind', 'manual'));

        $this->assertSame(3, ScheduleProposal::where('user_id', $id)->where('status', 'accepted')->count());
        $this->assertSame(1, ScheduleProposal::where('user_id', $id)->where('status', 'pending')->where('days', 7)->count(), 'next week draft');
        $this->assertSame(1, ScheduleProposal::where('user_id', $id)->where('status', 'pending')->where('days', 1)->count(), 'plan my day draft');
        $this->assertSame(3, WeeklyReview::where('user_id', $id)->where('status', 'completed')->whereNotNull('snapshot')->count());
        $this->assertTrue(AutomationRule::where('user_id', $id)->where('enabled', true)->exists() && AutomationRule::where('user_id', $id)->where('enabled', false)->exists());
        $this->assertEqualsCanonicalizing(['succeeded', 'skipped', 'failed'], AutomationRun::where('user_id', $id)->pluck('status')->unique()->values()->all());
        $this->assertSame(4, AssistantProposal::where('user_id', $id)->where('status', 'pending')->count());
        $this->assertEqualsCanonicalizing(['schedule', 'goal_plan', 'triage'], AssistantProposal::where('user_id', $id)->where('status', 'pending')->where('provider', 'local')->pluck('kind')->all());

        // V5: check-ins, richer focus sessions, life areas and milestones.
        $this->assertGreaterThanOrEqual(40, DailyCheckin::where('user_id', $id)->count());
        $this->assertNull(DailyCheckin::where('user_id', $id)->whereDate('date', CarbonImmutable::now('Europe/Amsterdam')->toDateString())->first(), 'today is left open for a check-in');
        $this->assertEqualsCanonicalizing(['pomodoro', 'deep', 'custom'], $sessions->pluck('mode')->unique()->values()->all());
        $this->assertGreaterThan(5, $sessions->whereNotNull('interruptions')->count());
        $this->assertGreaterThan(2, $sessions->whereNotNull('notes')->count());
        $this->assertGreaterThan(20, $sessions->whereNotNull('project_id')->count());
        $this->assertEqualsCanonicalizing(['work', 'study', 'personal'], Category::where('user_id', $id)->pluck('area')->unique()->values()->all());
        $this->assertGreaterThanOrEqual(3, Goal::where('user_id', $id)->whereNotNull('milestones')->count());
        $analytics = app(AnalyticsService::class)->summary($this->demo(), 30);
        $this->assertTrue($analytics['energy']['reliable'], 'enough check-ins for the energy comparison');
        $this->assertGreaterThan(10, InboxNotification::where('user_id', $id)->count());
        $this->assertTrue(UserSetting::where('user_id', $id)->value('preferences')['demo_account']);
    }

    public function test_demo_scenarios_are_visible_through_the_real_services(): void
    {
        $this->seedDemo();
        $user = $this->demo();
        $planning = app(PlanningService::class);
        $calendar = app(CalendarService::class);

        $summary = $planning->summary($user, CarbonImmutable::now('Europe/Amsterdam')->startOfDay(), 7, [], []);
        $this->assertNotEmpty($summary['overload'], 'an overloaded day');
        $this->assertNotEmpty($planning->missedBlocks($user), 'a missed block that needs rescheduling');

        $conflicts = $calendar->occurrences($user, now()->toImmutable(), now()->addDays(14)->toImmutable())->filter(fn ($o) => $calendar->conflicts($user, $o['starts_at'], $o['ends_at'])->count() > 1);
        $this->assertSame(['Doctor appointment', 'Vendor call'], $conflicts->pluck('title')->unique()->sort()->values()->all(), 'exactly one intentional double booking');
        $this->assertTrue($calendar->occurrences($user, now()->toImmutable(), now()->addDays(7)->toImmutable())->contains('recurring', true));

        $streaks = app(HabitStreaks::class);
        $best = Habit::where('user_id', $user->id)->get()->map(fn (Habit $h) => $streaks->calculate(DB::table('habit_entries')->where('habit_id', $h->id)->pluck('date')->map(fn ($d) => substr((string) $d, 0, 10)), $h->recurrence, CarbonImmutable::now('Europe/Amsterdam'))['current_streak'])->max();
        $this->assertGreaterThanOrEqual(10, $best, 'a habit streak');
        $this->assertTrue(Goal::where('user_id', $user->id)->get()->contains(fn (Goal $g) => $g->progress / $g->target >= 0.85 && $g->progress < $g->target), 'a goal approaching completion');
        $this->assertNotNull(AssistantProposal::where('user_id', $user->id)->where('provider', 'automation')->where('status', 'pending')->first(), 'an automation awaiting approval');
        $this->assertNotNull(AssistantProposal::where('user_id', $user->id)->where('provider', 'local')->where('status', 'pending')->first(), 'a pending AI scheduling proposal');
        $this->assertGreaterThan(0, WeeklyReview::where('user_id', $user->id)->first()->snapshot['completed']);
    }

    public function test_is_idempotent_and_never_touches_other_users(): void
    {
        $other = User::factory()->create();
        Task::create(['user_id' => $other->id, 'title' => 'Mine', 'status' => 'todo']);
        CalendarEvent::create(['user_id' => $other->id, 'title' => 'Real meeting', 'starts_at' => now()->addHour(), 'ends_at' => now()->addHours(2)]);
        $before = [Task::where('user_id', $other->id)->get()->toArray(), CalendarEvent::where('user_id', $other->id)->get()->toArray(), $other->fresh()->toArray()];
        Queue::fake();
        Http::fake();

        $this->seedDemo();
        $first = ['tasks' => Task::where('user_id', $this->demo()->id)->count(), 'events' => CalendarEvent::where('user_id', $this->demo()->id)->count(), 'sessions' => FocusSession::where('user_id', $this->demo()->id)->count(), 'notifications' => InboxNotification::where('user_id', $this->demo()->id)->count()];
        $demoId = $this->demo()->id;
        $this->seedDemo();
        $second = ['tasks' => Task::where('user_id', $demoId)->count(), 'events' => CalendarEvent::where('user_id', $demoId)->count(), 'sessions' => FocusSession::where('user_id', $demoId)->count(), 'notifications' => InboxNotification::where('user_id', $demoId)->count()];

        $this->assertSame($first, $second);
        $this->assertSame(2, User::count());
        $this->assertSame($demoId, $this->demo()->id, 'the account is reused, not recreated');
        $this->assertSame($before, [Task::where('user_id', $other->id)->get()->toArray(), CalendarEvent::where('user_id', $other->id)->get()->toArray(), $other->fresh()->toArray()]);
        Queue::assertNothingPushed();
        Http::assertNothingSent();
    }

    public function test_never_takes_over_a_real_account_with_the_demo_email(): void
    {
        $real = User::factory()->create(['email' => 'demo@lifeos.local']);
        Task::create(['user_id' => $real->id, 'title' => 'Real work']);

        $this->artisan('lifeos:demo')->assertFailed();
        $this->artisan('lifeos:demo --reset')->assertFailed();

        $this->assertSame(['Real work'], Task::where('user_id', $real->id)->pluck('title')->all());
    }

    public function test_reset_and_remove_only_affect_demo_records(): void
    {
        $other = User::factory()->create();
        Task::create(['user_id' => $other->id, 'title' => 'Keep me']);
        $this->seedDemo();

        $this->artisan('lifeos:demo --reset')->assertSuccessful();
        $this->assertSame(0, Task::where('user_id', $this->demo()->id)->count());
        $this->assertTrue(DemoMode::isDemo($this->demo()));

        $this->artisan('lifeos:demo --remove')->assertSuccessful();
        $this->assertSame(0, User::where('email', 'demo@lifeos.local')->count());
        $this->assertSame(['Keep me'], Task::pluck('title')->all());
        $this->assertSame(1, User::count());
    }

    public function test_demo_login_works_and_external_ai_is_off(): void
    {
        $this->seedDemo(password: 'demo-password-123');

        $this->postJson('/api/login', ['email' => 'demo@lifeos.local', 'password' => 'demo-password-123'])->assertOk();
        $this->getJson('/api/assistant/status')->assertJsonPath('external_allowed', false);
        $this->getJson('/api/tasks?per_page=100')->assertOk();
        $this->getJson('/api/analytics?days=30')->assertOk();
    }

    public function test_generates_a_password_for_a_new_account_and_supports_arabic_content(): void
    {
        $seeder = $this->seedDemo('ar', null);

        $this->assertSame(20, strlen($seeder->generatedPassword));
        $this->assertTrue(Hash::check($seeder->generatedPassword, $this->demo()->password));
        $this->assertSame('ar', $this->demo()->preferences()['language']);
        $this->assertMatchesRegularExpression('/\p{Arabic}/u', Task::where('user_id', $this->demo()->id)->value('title'));
        $this->assertMatchesRegularExpression('/\p{Arabic}/u', Project::where('user_id', $this->demo()->id)->value('title'));
    }

    public function test_command_prints_login_instructions(): void
    {
        $this->artisan('lifeos:demo --password=local-only-pass')->expectsOutputToContain('demo@lifeos.local')->assertSuccessful();
        $this->postJson('/api/login', ['email' => 'demo@lifeos.local', 'password' => 'local-only-pass'])->assertOk();
    }

    public function test_scenarios_hold_whatever_day_the_demo_is_seeded(): void
    {
        foreach (['2026-10-24 11:00', '2027-01-04 06:00', '2027-03-28 02:30', '2028-02-29 23:50'] as $moment) {
            $this->travelTo(CarbonImmutable::parse($moment, 'Europe/Amsterdam'));
            $user = $this->seedDemo()->user();
            $planning = app(PlanningService::class);
            $calendar = app(CalendarService::class);

            $this->assertNotEmpty($planning->summary($user, CarbonImmutable::now('Europe/Amsterdam')->startOfDay(), 7, [], [])['overload'], "overload on {$moment}");
            $this->assertCount(2, $planning->missedBlocks($user), "missed blocks on {$moment}");
            $this->assertSame(4, AssistantProposal::where('user_id', $user->id)->where('status', 'pending')->count(), "pending proposals on {$moment}");
            $this->assertSame(1, ScheduleProposal::where('user_id', $user->id)->where('status', 'pending')->where('days', 1)->count(), "day plan on {$moment}");
            $doubleBooked = $calendar->occurrences($user, now()->toImmutable(), now()->addDays(14)->toImmutable())->filter(fn ($o) => $calendar->conflicts($user, $o['starts_at'], $o['ends_at'])->count() > 1)->pluck('title')->unique()->sort()->values()->all();
            $this->assertSame(['Doctor appointment', 'Vendor call'], $doubleBooked, "conflicts on {$moment}");
        }
    }
}
