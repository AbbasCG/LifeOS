<?php

namespace Tests\Feature;

use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\ExternalEvent;
use App\Models\ExternalTask;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TimelineTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private CalendarAccount $google;

    private CalendarAccount $outlook;

    private CalendarAccount $todoist;

    protected function setUp(): void
    {
        parent::setUp();
        // Tuesday 23 March 2027, 07:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2027-03-23 07:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5]]]);
        $make = fn (string $provider, string $email) => CalendarAccount::create(['user_id' => $this->user->id, 'provider' => $provider, 'external_account_id' => $provider, 'email' => $email, 'access_token' => 'x', 'status' => 'active']);
        $this->google = $make('google', 'me@gmail.com');
        $this->outlook = $make('outlook', 'me@work.com');
        $this->todoist = $make('todoist', 'me@todoist.test');
    }

    private function at(string $local): CarbonImmutable
    {
        return CarbonImmutable::parse($local, 'Europe/Amsterdam')->utc();
    }

    private function external(CalendarAccount $account, string $id, string $title, string $start, string $end, array $extra = []): ExternalEvent
    {
        return ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'c', 'external_id' => $id, 'title' => $title, 'starts_at' => $this->at($start), 'ends_at' => $this->at($end)] + $extra);
    }

    public function test_one_stream_from_every_source_without_duplicates(): void
    {
        $study = Category::factory()->create(['user_id' => $this->user->id, 'area' => 'study']);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Dentist', 'starts_at' => $this->at('2027-03-23 16:00'), 'ends_at' => $this->at('2027-03-23 16:30'), 'kind' => 'fixed']);
        $this->external($this->google, 'g1', 'Board meeting', '2027-03-23 10:00', '2027-03-23 11:00', ['ical_uid' => 'UID-1']);
        $this->external($this->outlook, 'o1', 'FW: Board meeting', '2027-03-23 10:00', '2027-03-23 11:00', ['ical_uid' => 'uid-1']);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Read chapter 4', 'category_id' => $study->id, 'due_at' => $this->at('2027-03-23 18:00')]);
        ExternalTask::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->todoist->id, 'external_id' => '1', 'list_id' => 'inbox', 'title' => 'Call bank', 'due_at' => $this->at('2027-03-23 23:59'), 'due_is_date' => true]);
        $copied = ExternalTask::create(['user_id' => $this->user->id, 'calendar_account_id' => $this->todoist->id, 'external_id' => '2', 'list_id' => 'inbox', 'title' => 'Pay rent', 'due_at' => $this->at('2027-03-23 23:59')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Pay rent', 'due_at' => $this->at('2027-03-23 23:59'), 'source_ref' => $copied->sourceRef('todoist')]);
        FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 1500, 'elapsed_seconds' => 1500, 'started_at' => $this->at('2027-03-22 09:00'), 'completed_at' => $this->at('2027-03-22 09:25')]);
        Goal::factory()->create(['user_id' => $this->user->id, 'title' => 'Ship v2', 'due_at' => $this->at('2027-03-24 17:00')]);
        $habit = Habit::create(['user_id' => $this->user->id, 'title' => 'Meditate', 'recurrence' => 'daily', 'routine' => 'morning']);
        HabitEntry::create(['habit_id' => $habit->id, 'date' => '2027-03-22']);
        Task::factory()->create(['title' => 'Someone else', 'due_at' => $this->at('2027-03-23 12:00')]);

        $r = $this->actingAs($this->user)->getJson('/api/timeline?from=2027-03-22&to=2027-03-24')->assertOk();
        $items = collect($r->json('items'));
        $this->assertSame(1, $items->where('kind', 'event')->filter(fn ($i) => str_contains($i['title'], 'Board meeting'))->count(), 'one meeting, two calendars');
        $this->assertSame(1, $items->where('title', 'Pay rent')->count(), 'a copied task appears once, as the LifeOS task');
        $this->assertSame('task', $items->firstWhere('title', 'Pay rent')['kind']);
        $call = $items->firstWhere('title', 'Call bank');
        $this->assertSame(['external_task', 'todoist', 'Todoist', true], [$call['kind'], $call['source'], $call['source_label'], $call['read_only']]);
        $board = $items->first(fn ($i) => str_contains($i['title'], 'Board meeting'));
        $this->assertSame(['google', true, 'me@gmail.com'], [$board['source'], $board['read_only'], $board['account']]);
        $this->assertFalse($items->firstWhere('title', 'Dentist')['read_only']);
        $this->assertSame('study', $items->firstWhere('title', 'Read chapter 4')['area']);
        $this->assertSame(1, $items->where('kind', 'focus')->count());
        $this->assertSame(1, $items->where('kind', 'goal')->count());
        $meditations = $items->where('kind', 'habit')->values();
        $this->assertCount(3, $meditations, 'a daily habit appears on each day');
        $this->assertSame(['07:30', 'completed'], [CarbonImmutable::parse($meditations[0]['starts_at'])->setTimezone('Europe/Amsterdam')->format('H:i'), $meditations[0]['status']]);
        $this->assertStringNotContainsString('Someone else', $r->getContent());
        $this->assertSame('Europe/Amsterdam', $r->json('range.timezone'));
        $timed = $items->where('all_day', false)->pluck('starts_at')->map(fn ($s) => CarbonImmutable::parse($s)->getTimestamp())->values()->all();
        $this->assertSame($timed, collect($timed)->sort()->values()->all(), 'chronological across sources with different offsets');
        $this->assertSame($items->pluck('all_day')->sortDesc()->values()->all(), $items->pluck('all_day')->all(), 'all-day items first');
        $this->assertSame(1, collect($r->json('facets.accounts'))->firstWhere('provider', 'todoist')['count']);
    }

    public function test_filters_by_source_account_area_and_kind(): void
    {
        $study = Category::factory()->create(['user_id' => $this->user->id, 'area' => 'study']);
        $this->external($this->google, 'g1', 'Google thing', '2027-03-23 10:00', '2027-03-23 11:00');
        $this->external($this->outlook, 'o1', 'Outlook thing', '2027-03-23 12:00', '2027-03-23 13:00');
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Study task', 'category_id' => $study->id, 'due_at' => $this->at('2027-03-23 18:00')]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Plain task', 'due_at' => $this->at('2027-03-23 18:00')]);
        $get = fn (string $q) => collect($this->actingAs($this->user)->getJson('/api/timeline?from=2027-03-23&'.$q)->assertOk()->json('items'))->pluck('title')->all();

        $this->assertSame(['Google thing'], $get('sources=google'));
        $this->assertSame(['Outlook thing'], $get("accounts={$this->outlook->id}"));
        $this->assertSame(['Study task'], $get('areas=study'));
        $this->assertSame(['Plain task', 'Study task'], collect($get('kinds=task'))->sort()->values()->all());
        $this->assertSame([], $get('accounts=999999'));
        $this->actingAs($this->user)->getJson('/api/timeline?from=2027-03-01&to=2027-04-15')->assertUnprocessable();
        $this->actingAs($this->user)->getJson('/api/timeline?kinds=bogus')->assertUnprocessable();
    }

    public function test_conflicts_use_stable_identifiers_and_flag_the_affected_items(): void
    {
        $task = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Write report', 'estimated_minutes' => 60]);
        $block = CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => 'Write report', 'kind' => 'flexible', 'starts_at' => $this->at('2027-03-23 10:30'), 'ends_at' => $this->at('2027-03-23 11:30')]);
        $meeting = $this->external($this->google, 'g1', 'Client call', '2027-03-23 10:00', '2027-03-23 11:00', ['ical_uid' => 'U1']);
        $this->external($this->outlook, 'o1', 'Client call', '2027-03-23 10:00', '2027-03-23 11:00', ['ical_uid' => 'U1']);
        $this->external($this->google, 'g2', 'NY sync', '2027-03-23 15:00', '2027-03-23 15:30', ['timezone' => 'America/New_York']);
        $this->external($this->google, 'g3', 'Retro', '2027-03-23 14:00', '2027-03-23 14:30', ['previous_starts_at' => $this->at('2027-03-23 13:00'), 'changed_at' => now()->subHour()]);
        Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Scheduled call prep', 'scheduled_start' => $this->at('2027-03-23 15:00'), 'scheduled_end' => $this->at('2027-03-23 15:20')]);

        $r = $this->actingAs($this->user)->getJson('/api/timeline?from=2027-03-23')->assertOk();
        $conflicts = collect($r->json('conflicts'));
        $busy = $conflicts->where('type', 'busy_task')->values();
        $this->assertCount(2, $busy);
        $this->assertEqualsCanonicalizing(['ev:e'.$block->id, 'ev:x'.$meeting->id], $busy[0]['items']);
        $this->assertSame(30, $busy[0]['minutes']);
        $this->assertSame(['task:'.Task::where('title', 'Scheduled call prep')->value('id')], array_slice($busy[1]['items'], 0, 1));
        $duplicate = $conflicts->firstWhere('type', 'duplicate');
        $this->assertEqualsCanonicalizing(['me@gmail.com', 'me@work.com'], $duplicate['accounts']);
        $tz = $conflicts->firstWhere('type', 'timezone');
        $this->assertSame(['10:00', '15:00', 'America/New_York'], [$tz['organiser_time'], $tz['your_time'], $tz['organiser_zone']]);
        $this->assertSame('Retro', $conflicts->firstWhere('type', 'moved')['titles'][0]);
        $flagged = collect($r->json('items'))->where('conflict', true)->pluck('title')->all();
        $this->assertContains('Write report', $flagged);
        $this->assertContains('Client call', $flagged);
        $this->assertNotContains('Retro', $flagged, 'informational changes are not flagged as conflicts');
    }

    public function test_moving_a_lifeos_event_previews_conflicts_before_saving(): void
    {
        $block = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Write report', 'kind' => 'flexible', 'starts_at' => $this->at('2027-03-23 10:30'), 'ends_at' => $this->at('2027-03-23 11:30')]);
        $standup = CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Stand-up', 'kind' => 'flexible', 'timezone' => 'Europe/Amsterdam', 'recurrence' => ['freq' => 'daily'], 'starts_at' => $this->at('2027-03-22 09:00'), 'ends_at' => $this->at('2027-03-22 09:15')]);
        $this->external($this->google, 'g1', 'Client call', '2027-03-23 13:00', '2027-03-23 14:00');
        $items = collect($this->actingAs($this->user)->getJson('/api/timeline?from=2027-03-23')->assertOk()->json('items'));
        $this->assertSame($block->id, $items->firstWhere('title', 'Write report')['meta']['event_id']);
        $occurrence = $items->firstWhere('title', 'Stand-up')['meta'];
        $this->assertSame([$standup->id, $this->at('2027-03-23 09:00')->toIso8601String()], [$occurrence['event_id'], $occurrence['occurrence_start']]);
        $this->assertArrayNotHasKey('event_id', $items->firstWhere('title', 'Client call')['meta'], 'connected events cannot be moved');

        $preview = fn (array $q) => $this->getJson('/api/timeline/preview?'.http_build_query($q))->assertOk();
        $clash = $preview(['event_id' => $block->id, 'starts_at' => $this->at('2027-03-23 13:30')->toIso8601String(), 'ends_at' => $this->at('2027-03-23 14:30')->toIso8601String()]);
        $this->assertSame([['Client call', 'google', true, 30]], collect($clash->json('conflicts'))->map(fn ($c) => [$c['title'], $c['source'], $c['read_only'], $c['minutes']])->all());
        $this->assertSame([], $preview(['event_id' => $block->id, 'starts_at' => $this->at('2027-03-23 10:45')->toIso8601String(), 'ends_at' => $this->at('2027-03-23 11:45')->toIso8601String()])->json('conflicts'), 'its own old slot is not a conflict');
        $this->assertSame([], $preview(['event_id' => $standup->id, 'occurrence_start' => $occurrence['occurrence_start'], 'starts_at' => $this->at('2027-03-23 09:05')->toIso8601String(), 'ends_at' => $this->at('2027-03-23 09:20')->toIso8601String()])->json('conflicts'));
        $this->assertSame(['Stand-up'], collect($preview(['event_id' => $block->id, 'starts_at' => $this->at('2027-03-24 09:00')->toIso8601String(), 'ends_at' => $this->at('2027-03-24 10:00')->toIso8601String()])->json('conflicts'))->pluck('title')->all());

        // Saving uses the calendar endpoint, which enforces the same rule.
        $this->patchJson("/api/events/{$block->id}", ['starts_at' => $this->at('2027-03-23 13:30')->toIso8601String(), 'ends_at' => $this->at('2027-03-23 14:30')->toIso8601String()])->assertUnprocessable();
        $this->patchJson("/api/events/{$block->id}", ['starts_at' => $this->at('2027-03-23 15:00')->toIso8601String(), 'ends_at' => $this->at('2027-03-23 16:00')->toIso8601String()])->assertOk();
        $this->assertSame('15:00', $block->fresh()->starts_at->setTimezone('Europe/Amsterdam')->format('H:i'));

        $other = CalendarEvent::create(['user_id' => User::factory()->create()->id, 'title' => 'Not mine', 'starts_at' => $this->at('2027-03-23 08:00'), 'ends_at' => $this->at('2027-03-23 09:00')]);
        $this->getJson('/api/timeline/preview?'.http_build_query(['event_id' => $other->id, 'starts_at' => '2027-03-23T10:00:00Z', 'ends_at' => '2027-03-23T11:00:00Z']))->assertNotFound();
        $this->getJson('/api/timeline/preview?'.http_build_query(['event_id' => $block->id, 'starts_at' => '2027-03-23T10:00:00Z', 'ends_at' => '2027-03-23T09:00:00Z']))->assertUnprocessable();
    }
}
