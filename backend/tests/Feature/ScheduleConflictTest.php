<?php

namespace Tests\Feature;

use App\Models\AssistantProposal;
use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\CalendarEventException;
use App\Models\ExternalEvent;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarBooking;
use App\Services\CalendarService;
use Carbon\CarbonImmutable;
use Database\Seeders\LifeOSDemoSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Overlaps are refused on every path that creates or moves a calendar event, with a structured `conflict` object next to the unchanged
 * 422 `message` / `errors`. Half-open [start, end): a block that ends when another starts is fine.
 *
 * "Now" is Monday 2027-02-01 08:00 UTC; the user has no settings, so working hours are the planner defaults (09:00-17:00, Monday to Friday, UTC).
 */
class ScheduleConflictTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
    }

    /** @return array{starts_at: string, ends_at: string} */
    private function slot(string $from, string $to, string $day = '2027-02-03'): array
    {
        return ['starts_at' => "{$day}T{$from}:00Z", 'ends_at' => "{$day}T{$to}:00Z"];
    }

    private function task(?User $owner = null, string $title = 'A task', array $attributes = []): Task
    {
        return Task::factory()->create(['user_id' => ($owner ?? $this->user)->id, 'title' => $title] + $attributes);
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function event(string $title, string $from, string $to, string $day = '2027-02-03', ?User $owner = null, array $attributes = []): CalendarEvent
    {
        return CalendarEvent::factory()->create(['user_id' => ($owner ?? $this->user)->id, 'title' => $title, 'starts_at' => "{$day} {$from}:00", 'ends_at' => "{$day} {$to}:00"] + $attributes);
    }

    private function bookedSession(Task $task, string $from, string $to, string $day = '2027-02-03', ?User $owner = null): CalendarEvent
    {
        return $this->event($task->title, $from, $to, $day, $owner, ['task_id' => $task->id, 'kind' => 'flexible']);
    }

    private function external(string $title, string $from, string $to, string $day = '2027-02-03', ?User $owner = null, string $provider = 'google'): ExternalEvent
    {
        $owner ??= $this->user;
        $account = CalendarAccount::firstOrCreate(['user_id' => $owner->id, 'provider' => $provider, 'external_account_id' => $provider.$owner->id], ['email' => "{$provider}@example.test", 'access_token' => 'x', 'status' => 'active']);

        return ExternalEvent::create(['user_id' => $owner->id, 'calendar_account_id' => $account->id, 'calendar_id' => 'primary', 'external_id' => $title.$from.$day, 'title' => $title, 'starts_at' => "{$day} {$from}:00", 'ends_at' => "{$day} {$to}:00"]);
    }

    /** The shape every refusal has, whatever the path. */
    private function assertConflict(TestResponse $response, string $errorKey): array
    {
        $response->assertUnprocessable()->assertJsonStructure(['message', 'errors' => [$errorKey], 'conflict' => ['code', 'requested' => ['starts_at', 'ends_at'], 'conflicts', 'suggestion']])
            ->assertJsonPath('conflict.code', 'schedule_conflict');
        $this->assertSame($response->json("errors.{$errorKey}.0"), $response->json('message'), 'the plain-text message is the validation message');

        return $response->json('conflict');
    }

    public function test_a_free_slot_is_accepted_on_the_task_and_event_paths(): void
    {
        $task = $this->task();
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('09:00', '09:30'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'Lunch', 'kind' => 'fixed'] + $this->slot('12:00', '13:00'))->assertCreated();
        $other = $this->task(null, 'Other');
        $this->postJson('/api/events', ['title' => 'Other', 'task_id' => $other->id] + $this->slot('14:00', '15:00'))->assertCreated();
        $this->assertSame(3, CalendarEvent::count());
    }

    public function test_adjacent_blocks_are_allowed_and_an_overlap_of_a_quarter_hour_is_not(): void
    {
        $first = $this->task(null, 'First');
        $second = $this->task(null, 'Second');
        $this->postJson("/api/tasks/{$first->id}/schedule", $this->slot('09:00', '09:30'))->assertCreated();
        $this->postJson("/api/tasks/{$second->id}/schedule", $this->slot('09:30', '10:00'))->assertCreated();

        $third = $this->task(null, 'Third');
        $this->postJson("/api/tasks/{$third->id}/schedule", $this->slot('09:15', '09:45'))->assertUnprocessable();
        $this->postJson("/api/tasks/{$third->id}/schedule", $this->slot('08:30', '09:00'))->assertCreated();
        $this->assertSame(0, CalendarEvent::where('task_id', $third->id)->where('starts_at', '2027-02-03 09:15:00')->count());
    }

    public function test_the_refusal_carries_a_structured_conflict_and_keeps_the_old_422_shape(): void
    {
        $writing = $this->task(null, 'Write report');
        $review = $this->task(null, 'Review');
        $existing = $this->bookedSession($writing, '09:00', '09:30');

        $response = $this->postJson("/api/tasks/{$review->id}/schedule", $this->slot('09:15', '09:45'));

        $response->assertUnprocessable()
            ->assertJsonPath('message', 'This time conflicts with “Write report” (2027-02-03T09:00:00+00:00 – 2027-02-03T09:30:00+00:00). Choose another time.')
            ->assertJsonPath('errors.starts_at.0', 'This time conflicts with “Write report” (2027-02-03T09:00:00+00:00 – 2027-02-03T09:30:00+00:00). Choose another time.')
            ->assertExactJson([
                'message' => 'This time conflicts with “Write report” (2027-02-03T09:00:00+00:00 – 2027-02-03T09:30:00+00:00). Choose another time.',
                'errors' => ['starts_at' => ['This time conflicts with “Write report” (2027-02-03T09:00:00+00:00 – 2027-02-03T09:30:00+00:00). Choose another time.']],
                'conflict' => [
                    'code' => 'schedule_conflict',
                    'requested' => ['starts_at' => '2027-02-03T09:15:00Z', 'ends_at' => '2027-02-03T09:45:00Z'],
                    'conflicts' => [[
                        'id' => $existing->id, 'event_id' => $existing->id, 'task_id' => $writing->id, 'title' => 'Write report', 'kind' => 'task_session', 'source' => 'lifeos',
                        'starts_at' => '2027-02-03T09:00:00Z', 'ends_at' => '2027-02-03T09:30:00Z', 'overlap_minutes' => 15,
                    ]],
                    'suggestion' => ['starts_at' => '2027-02-03T09:30:00Z', 'ends_at' => '2027-02-03T10:00:00Z'],
                ],
            ]);
        $this->assertSame(0, CalendarEvent::where('task_id', $review->id)->count(), 'a refused request creates nothing');
    }

    public function test_conflicts_list_at_most_five_items_earliest_first_with_their_kinds(): void
    {
        $this->event('Plain', '09:00', '09:10');
        $this->bookedSession($this->task(null, 'Session'), '09:10', '09:20');
        $this->external('Dentist', '09:20', '09:30');
        $this->event('Extra 0', '09:30', '09:40');
        $this->event('Extra 1', '09:40', '09:50');
        $this->event('Extra 2', '09:50', '10:00');
        $this->event('Late', '10:30', '11:00');

        $conflict = $this->assertConflict($this->postJson('/api/events', ['title' => 'Big'] + $this->slot('09:00', '11:00')), 'starts_at');

        $this->assertCount(5, $conflict['conflicts']);
        $this->assertSame(['Plain', 'Session', 'Dentist', 'Extra 0', 'Extra 1'], array_column($conflict['conflicts'], 'title'));
        $this->assertSame(['event', 'task_session', 'external', 'event', 'event'], array_column($conflict['conflicts'], 'kind'));
        $this->assertSame(['lifeos', 'lifeos', 'google', 'lifeos', 'lifeos'], array_column($conflict['conflicts'], 'source'));
        $this->assertSame([10, 10, 10, 10, 10], array_column($conflict['conflicts'], 'overlap_minutes'));
    }

    public function test_an_external_calendar_event_blocks_and_is_described_without_a_lifeos_event_id(): void
    {
        $external = $this->external('Client call', '10:00', '11:00');
        $task = $this->task();

        $conflict = $this->assertConflict($this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('10:30', '11:30')), 'starts_at');

        $this->assertSame([['id' => $external->id, 'event_id' => null, 'task_id' => null, 'title' => 'Client call', 'kind' => 'external', 'source' => 'google',
            'starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T11:00:00Z', 'overlap_minutes' => 30]], $conflict['conflicts']);
        $this->assertSame(['starts_at' => '2027-02-03T11:00:00Z', 'ends_at' => '2027-02-03T12:00:00Z'], $conflict['suggestion']);
        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('11:00', '12:00'))->assertCreated();
    }

    public function test_a_revoked_calendar_account_no_longer_blocks(): void
    {
        $this->external('Old meeting', '10:00', '11:00');
        CalendarAccount::query()->update(['status' => 'revoked']);

        $this->postJson('/api/events', ['title' => 'Mine'] + $this->slot('10:00', '11:00'))->assertCreated();
    }

    public function test_another_users_calendar_never_blocks_and_never_leaks(): void
    {
        $stranger = User::factory()->create();
        $theirs = $this->task($stranger, 'Secret project');
        $this->bookedSession($theirs, '09:00', '10:00', '2027-02-03', $stranger);
        $this->external('Private doctor', '09:00', '10:00', '2027-02-03', $stranger);
        $this->event('Mine', '10:00', '10:30');
        $task = $this->task();

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('09:00', '10:00'))->assertCreated();
        $response = $this->postJson('/api/events', ['title' => 'Clash'] + $this->slot('10:00', '10:30'));
        $conflict = $this->assertConflict($response, 'starts_at');

        $this->assertSame(['Mine'], array_column($conflict['conflicts'], 'title'));
        $this->assertStringNotContainsString('Secret project', $response->getContent());
        $this->assertStringNotContainsString('Private doctor', $response->getContent());
        $this->assertNull(collect($conflict['conflicts'])->firstWhere('title', 'Secret project'));
        // The stranger's own booking in the same slot is not blocked by mine either.
        $this->actingAs($stranger)->postJson('/api/events', ['title' => 'Theirs too'] + $this->slot('10:00', '10:30'))->assertCreated();
    }

    public function test_a_cancelled_occurrence_and_a_deleted_event_free_their_slot(): void
    {
        $series = $this->event('Standup', '09:00', '09:30', '2027-02-03', null, ['recurrence' => ['freq' => 'daily', 'interval' => 1], 'timezone' => 'UTC', 'kind' => 'fixed']);
        $this->postJson('/api/events', ['title' => 'In the way'] + $this->slot('09:00', '09:30', '2027-02-04'))->assertUnprocessable();

        $this->deleteJson("/api/events/{$series->id}", ['scope' => 'occurrence', 'occurrence_start' => '2027-02-04T09:00:00Z'])->assertOk();
        $this->assertTrue(CalendarEventException::where('calendar_event_id', $series->id)->where('cancelled', true)->exists());
        $this->postJson('/api/events', ['title' => 'Now fine'] + $this->slot('09:00', '09:30', '2027-02-04'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'Day after'] + $this->slot('09:00', '09:30', '2027-02-05'))->assertUnprocessable();

        $single = $this->event('One-off', '13:00', '14:00');
        $this->postJson('/api/events', ['title' => 'Blocked'] + $this->slot('13:00', '14:00'))->assertUnprocessable();
        $this->deleteJson("/api/events/{$single->id}")->assertOk();
        $this->postJson('/api/events', ['title' => 'Free now'] + $this->slot('13:00', '14:00'))->assertCreated();
    }

    public function test_a_deleted_session_frees_the_slot_for_another_task(): void
    {
        $first = $this->task(null, 'First');
        $second = $this->task(null, 'Second');
        $id = $this->postJson("/api/tasks/{$first->id}/schedule", $this->slot('09:00', '10:00'))->assertCreated()->json('data.id');
        $this->postJson("/api/tasks/{$second->id}/schedule", $this->slot('09:00', '10:00'))->assertUnprocessable();

        $this->deleteJson("/api/events/{$id}")->assertOk();

        $this->postJson("/api/tasks/{$second->id}/schedule", $this->slot('09:00', '10:00'))->assertCreated();
    }

    public function test_the_future_session_of_a_completed_task_stays_a_calendar_event_but_no_longer_blocks(): void
    {
        $done = $this->task(null, 'Shipped', ['status' => 'completed', 'completed_at' => now()]);
        $session = $this->bookedSession($done, '09:00', '10:00');

        // Finishing a task early frees its later slot (see ClosedTaskSessionsTest); the block itself is not deleted.
        $this->postJson('/api/events', ['title' => 'Other'] + $this->slot('09:30', '10:30'))->assertCreated();
        $this->assertTrue(CalendarEvent::whereKey($session->id)->exists());
    }

    public function test_a_completed_task_cannot_get_a_session_through_any_creation_path(): void
    {
        $done = $this->task(null, 'Shipped', ['status' => 'completed', 'completed_at' => now()]);

        $this->postJson("/api/tasks/{$done->id}/schedule", $this->slot('09:00', '10:00'))->assertUnprocessable()->assertJsonValidationErrors('task');
        $this->postJson('/api/events', ['title' => 'Shipped', 'task_id' => $done->id] + $this->slot('09:00', '10:00'))->assertUnprocessable()->assertJsonValidationErrors('task');
        $plain = $this->event('Plain', '11:00', '12:00');
        $this->patchJson("/api/events/{$plain->id}", ['task_id' => $done->id])->assertUnprocessable()->assertJsonValidationErrors('task');
        $this->assertSame(0, CalendarEvent::where('task_id', $done->id)->count());

        $proposal = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'focus_blocks', 'provider' => 'local', 'summary' => 'x', 'explanation' => [], 'expires_at' => now()->addHour(), 'actions' => [
            ['id' => 'a1', 'type' => 'create_event', 'title' => 'Shipped', 'task_id' => $done->id, 'starts_at' => '2027-02-03T13:00:00+00:00', 'ends_at' => '2027-02-03T14:00:00+00:00', 'minutes' => 60],
        ]]);
        $this->postJson("/api/assistant/proposals/{$proposal->id}/apply", ['action_ids' => ['a1']])->assertUnprocessable()->assertJsonValidationErrors('actions');
        $this->assertSame(0, CalendarEvent::where('task_id', $done->id)->count());
    }

    public function test_moving_a_session_into_a_busy_slot_is_refused_and_the_original_is_unchanged(): void
    {
        $task = $this->task(null, 'Mover');
        $busy = $this->event('Busy', '10:00', '11:00');
        $session = $this->bookedSession($task, '09:00', '09:30');

        $conflict = $this->assertConflict($this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('10:30', '11:30')), 'starts_at');
        $this->assertSame($busy->id, $conflict['conflicts'][0]['event_id']);
        $this->assertSame(['starts_at' => '2027-02-03T11:00:00Z', 'ends_at' => '2027-02-03T12:00:00Z'], $conflict['suggestion']);
        $this->assertConflict($this->patchJson("/api/events/{$session->id}", $this->slot('09:45', '10:15')), 'starts_at');

        $fresh = $session->fresh();
        $this->assertSame('2027-02-03 09:00:00', $fresh->starts_at->format('Y-m-d H:i:s'));
        $this->assertSame('2027-02-03 09:30:00', $fresh->ends_at->format('Y-m-d H:i:s'));
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_a_session_can_move_onto_its_own_old_time_and_overlap_itself(): void
    {
        $task = $this->task();
        $session = $this->bookedSession($task, '09:00', '10:00');

        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('09:00', '10:00'))->assertOk();
        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('09:30', '10:30'))->assertOk()->assertJsonPath('data.id', $session->id);
        $this->patchJson("/api/events/{$session->id}", $this->slot('09:30', '10:30'))->assertOk();
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_every_creation_and_move_path_refuses_an_overlap(): void
    {
        $this->event('Wall', '09:00', '17:00');
        $taskA = $this->task(null, 'A');
        $movable = $this->bookedSession($this->task(null, 'Movable'), '17:30', '18:00');
        $busy = $this->slot('10:00', '10:30');

        // POST /api/events (plain, with a task, and as a series), POST/PUT /api/tasks/{id}/schedule, PATCH /api/events/{id}.
        $this->assertConflict($this->postJson('/api/events', ['title' => 'Plain'] + $busy), 'starts_at');
        $this->assertConflict($this->postJson('/api/events', ['title' => 'With task', 'task_id' => $taskA->id] + $busy), 'starts_at');
        $this->assertConflict($this->postJson("/api/tasks/{$taskA->id}/schedule", $busy), 'starts_at');
        $this->assertConflict($this->patchJson("/api/events/{$movable->id}", $busy), 'starts_at');
        $this->assertConflict($this->putJson("/api/tasks/{$movable->task_id}/schedule", $busy), 'starts_at');
        $series = $this->assertConflict($this->postJson('/api/events', ['title' => 'Series', 'recurrence' => ['freq' => 'daily', 'count' => 3]] + $busy), 'recurrence_conflicts');
        $this->assertNull($series['suggestion'], 'a series has no single slot to suggest');
        $this->assertSame(['starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T10:30:00Z'], $series['requested']);
        $this->assertSame('Wall', $series['conflicts'][0]['title']);
        $this->assertSame(0, CalendarEvent::where('task_id', $taskA->id)->count());
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_the_generic_workspace_writer_never_serves_events(): void
    {
        foreach (['POST' => '/api/events', 'PATCH' => '/api/events/1', 'DELETE' => '/api/events/1'] as $method => $uri) {
            $route = app('router')->getRoutes()->match(app('request')->create($uri, $method));
            $this->assertSame('App\Http\Controllers\CalendarController', $route->getControllerClass(), "$method $uri is served by CalendarController");
        }
    }

    public function test_a_recurring_occurrence_moved_onto_a_busy_slot_is_refused_and_a_series_clash_is_reported(): void
    {
        $series = $this->event('Standup', '09:00', '09:30', '2027-02-03', null, ['recurrence' => ['freq' => 'daily', 'interval' => 1], 'timezone' => 'UTC', 'kind' => 'flexible']);
        $this->event('Dentist', '14:00', '15:00', '2027-02-04');

        $conflict = $this->assertConflict($this->patchJson("/api/events/{$series->id}", ['scope' => 'occurrence', 'occurrence_start' => '2027-02-04T09:00:00Z'] + $this->slot('14:30', '15:30', '2027-02-04')), 'starts_at');
        $this->assertSame('Dentist', $conflict['conflicts'][0]['title']);
        $this->assertSame(0, CalendarEventException::count());
        $this->patchJson("/api/events/{$series->id}", ['scope' => 'occurrence', 'occurrence_start' => '2027-02-04T09:00:00Z'] + $this->slot('15:00', '15:30', '2027-02-04'))->assertOk();

        // A new series whose later occurrence clashes with the standup.
        $clash = $this->assertConflict($this->postJson('/api/events', ['title' => 'Daily review', 'recurrence' => ['freq' => 'daily', 'count' => 5]] + $this->slot('09:00', '09:30', '2027-02-05')), 'recurrence_conflicts');
        $this->assertSame('Standup', $clash['conflicts'][0]['title']);
        $this->postJson('/api/events', ['title' => 'Daily review', 'ignore_conflicts' => true, 'recurrence' => ['freq' => 'daily', 'count' => 5]] + $this->slot('09:00', '09:30', '2027-02-05'))->assertCreated();
    }

    public function test_the_suggestion_stays_inside_working_hours_skips_weekends_and_never_points_to_the_past(): void
    {
        // Friday 16:00-17:00 is taken, so a request for 16:30-17:30 gets Monday 09:00 (the weekend and the evening are outside working hours).
        $this->event('Late meeting', '16:00', '17:00', '2027-02-05');
        $conflict = $this->assertConflict($this->postJson('/api/events', ['title' => 'Late'] + $this->slot('16:30', '17:30', '2027-02-05')), 'starts_at');
        $this->assertSame(['starts_at' => '2027-02-08T09:00:00Z', 'ends_at' => '2027-02-08T10:00:00Z'], $conflict['suggestion']);

        // A request that already started: the suggestion is never earlier than the next whole minute from now (08:00 is before work hours, so 09:00).
        $this->travelTo(CarbonImmutable::parse('2027-02-02 10:07:30', 'UTC'));
        $this->event('Now', '09:30', '10:15', '2027-02-02');
        $past = $this->assertConflict($this->postJson('/api/events', ['title' => 'Started'] + $this->slot('09:45', '10:45', '2027-02-02')), 'starts_at');
        $this->assertSame(['starts_at' => '2027-02-02T10:15:00Z', 'ends_at' => '2027-02-02T11:15:00Z'], $past['suggestion']);
        $this->assertGreaterThanOrEqual(now()->timestamp, CarbonImmutable::parse($past['suggestion']['starts_at'])->timestamp);
    }

    public function test_the_suggestion_follows_the_users_working_hours_and_time_zone(): void
    {
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '10:00', 'work_end' => '12:00', 'work_days' => [1, 2, 3, 4, 5]]]);
        // Wednesday 10:00-11:30 Amsterdam (09:00-10:30Z) is taken; a 1h request has no room left that day (11:30-12:00 is 30 min), so Thursday 10:00 (09:00Z).
        $this->event('Block', '09:00', '10:30');

        $conflict = $this->assertConflict($this->postJson('/api/events', ['title' => 'Hour'] + $this->slot('09:30', '10:30')), 'starts_at');

        $this->assertSame(['starts_at' => '2027-02-04T09:00:00Z', 'ends_at' => '2027-02-04T10:00:00Z'], $conflict['suggestion']);
    }

    public function test_the_suggestion_is_null_when_nothing_is_free_for_a_week_and_ignores_the_event_being_moved(): void
    {
        foreach (range(2, 9) as $d) {
            $this->event("Wall {$d}", '00:00', '23:59', sprintf('2027-02-%02d', $d));
        }
        $this->event('Wall 10', '00:00', '23:59', '2027-02-10');
        $conflict = $this->assertConflict($this->postJson('/api/events', ['title' => 'Nowhere'] + $this->slot('09:00', '10:00', '2027-02-03')), 'starts_at');
        $this->assertNull($conflict['suggestion']);

        // The block being moved never counts as busy for its own suggestion.
        CalendarEvent::query()->delete();
        $mine = $this->event('Mine', '09:00', '10:00', '2027-02-03', null, ['kind' => 'flexible']);
        $booking = app(CalendarBooking::class);
        $start = CarbonImmutable::parse('2027-02-03 09:00', 'UTC');
        $this->assertSame(['starts_at' => '2027-02-03T09:00:00Z', 'ends_at' => '2027-02-03T10:00:00Z'], $booking->suggestSlot($this->user, $start, $start->addHour(), $mine->id));
        $this->assertSame(['starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T11:00:00Z'], $booking->suggestSlot($this->user, $start, $start->addHour()));
    }

    public function test_dst_gap_and_overlap_are_compared_as_instants(): void
    {
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->travelTo(CarbonImmutable::parse('2026-03-01 08:00', 'UTC'));
        // Spring forward 2026-03-29: 01:00Z is both 02:00 CET (does not exist) and 03:00 CEST. A block 01:30 CET-wall (00:30Z)-03:30 CEST (01:30Z) is 1h real time.
        $this->event('Across the gap', '00:30', '01:30', '2026-03-29');
        $this->postJson('/api/events', ['title' => 'Right after'] + $this->slot('01:30', '02:30', '2026-03-29'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'Overlaps by a minute'] + $this->slot('01:29', '01:45', '2026-03-29'))->assertUnprocessable();
        $conflict = $this->assertConflict($this->postJson('/api/events', ['title' => 'Local 03:15 CEST'] + ['starts_at' => '2026-03-29T03:15:00+02:00', 'ends_at' => '2026-03-29T03:45:00+02:00']), 'starts_at');
        $this->assertSame(['Across the gap', 'Right after'], array_column($conflict['conflicts'], 'title'), '03:15 CEST is 01:15Z, so it overlaps the block ending at 01:30Z and the one starting then');
    }

    public function test_dst_fall_back_hour_exists_twice_and_both_are_distinct_slots(): void
    {
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->travelTo(CarbonImmutable::parse('2026-10-01 08:00', 'UTC'));
        // 2026-10-25: 02:30 CEST = 00:30Z, 02:30 CET = 01:30Z. Two bookings at "02:30" local on different sides of the change do not overlap.
        $this->postJson('/api/events', ['title' => 'First 02:30', 'starts_at' => '2026-10-25T02:30:00+02:00', 'ends_at' => '2026-10-25T03:00:00+02:00'])->assertCreated();
        $this->postJson('/api/events', ['title' => 'Second 02:30', 'starts_at' => '2026-10-25T02:30:00+01:00', 'ends_at' => '2026-10-25T03:00:00+01:00'])->assertCreated();
        $this->postJson('/api/events', ['title' => 'A 90 minute block across the repeated hour', 'starts_at' => '2026-10-25T02:45:00+02:00', 'ends_at' => '2026-10-25T03:15:00+01:00'])->assertUnprocessable();
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_a_session_across_midnight_blocks_the_next_day_and_a_weekly_series_keeps_its_wall_clock_over_dst(): void
    {
        $this->event('Late shift', '23:30', '23:59', '2027-02-03');
        CalendarEvent::query()->update(['ends_at' => '2027-02-04 00:30:00']);
        $this->assertConflict($this->postJson('/api/events', ['title' => 'After midnight'] + $this->slot('00:00', '00:15', '2027-02-04')), 'starts_at');
        $this->postJson('/api/events', ['title' => 'Right after'] + $this->slot('00:30', '01:00', '2027-02-04'))->assertCreated();

        // 09:00 Amsterdam every Sunday: before the change it is 08:00Z, after it 07:00Z.
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
        $this->travelTo(CarbonImmutable::parse('2026-03-01 08:00', 'UTC'));
        $this->postJson('/api/events', ['title' => 'Sunday run', 'timezone' => 'Europe/Amsterdam', 'recurrence' => ['freq' => 'weekly', 'by_weekday' => [0], 'count' => 6]] + $this->slot('08:00', '09:00', '2026-03-22'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'Old summer time slot'] + $this->slot('08:00', '09:00', '2026-04-05'))->assertCreated();
        $this->postJson('/api/events', ['title' => 'New wall clock slot'] + $this->slot('07:00', '08:00', '2026-04-05'))->assertUnprocessable();
    }

    public function test_double_submits_retries_and_replays_never_create_a_second_event(): void
    {
        $task = $this->task();
        $body = $this->slot('09:00', '10:00');

        $first = $this->postJson("/api/tasks/{$task->id}/schedule", $body, ['Idempotency-Key' => 'k1'])->assertCreated()->json('data.id');
        $this->postJson("/api/tasks/{$task->id}/schedule", $body, ['Idempotency-Key' => 'k1'])->assertOk()->assertHeader('Idempotent-Replay', 'true')->assertJsonPath('data.id', $first);
        // Retry after a timeout, even when the slot is meanwhile taken by the first attempt itself: still the first event.
        $this->postJson("/api/tasks/{$task->id}/schedule", $body, ['Idempotency-Key' => 'k1'])->assertOk()->assertJsonPath('data.id', $first);
        // No key at all: the identical request is recognised as a replay, not a conflict with itself.
        $this->postJson("/api/tasks/{$task->id}/schedule", $body)->assertOk()->assertJsonPath('data.id', $first);
        $this->postJson('/api/events', ['title' => $task->title, 'task_id' => $task->id] + $body)->assertOk()->assertJsonPath('data.id', $first);
        $this->assertSame(1, CalendarEvent::count());

        // A plain event sent twice is a double booking and the second one is refused.
        $this->postJson('/api/events', ['title' => 'Lunch'] + $this->slot('12:00', '13:00'))->assertCreated();
        $this->assertConflict($this->postJson('/api/events', ['title' => 'Lunch'] + $this->slot('12:00', '13:00')), 'starts_at');
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_patching_a_task_never_creates_an_event_and_put_moves_the_same_row(): void
    {
        $task = $this->task();
        $session = $this->bookedSession($task, '09:00', '10:00');

        $this->patchJson("/api/tasks/{$task->id}", ['title' => 'Renamed', 'due_at' => '2027-02-10T12:00:00Z', 'estimated_minutes' => 30])->assertOk();
        $this->assertSame(1, CalendarEvent::count());

        $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('11:00', '12:00'))->assertOk()->assertJsonPath('data.id', $session->id);
        $this->assertSame(1, CalendarEvent::count());
        $this->assertSame('2027-02-03 11:00:00', $session->fresh()->starts_at->format('Y-m-d H:i:s'));
    }

    public function test_a_session_that_has_ended_is_not_active_and_does_not_block_a_new_one_for_the_task(): void
    {
        $task = $this->task();
        $this->bookedSession($task, '09:00', '10:00', '2027-01-20');

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('09:00', '10:00'))->assertCreated();
        $this->assertSame(2, CalendarEvent::count());
    }

    public function test_a_stale_tab_can_ask_for_a_conflict_check_with_expected_starts_at(): void
    {
        $task = $this->task();
        $session = $this->bookedSession($task, '09:00', '10:00');
        $this->patchJson("/api/events/{$session->id}", $this->slot('11:00', '12:00'))->assertOk();

        // The second tab still thinks it starts at 09:00.
        $this->patchJson("/api/events/{$session->id}", ['expected_starts_at' => '2027-02-03T09:00:00Z'] + $this->slot('13:00', '14:00'))->assertStatus(409)
            ->assertJsonPath('code', 'event_changed')->assertJsonPath('current.starts_at', '2027-02-03T11:00:00Z');
        $this->putJson("/api/tasks/{$task->id}/schedule", ['expected_starts_at' => '2027-02-03T09:00:00Z'] + $this->slot('13:00', '14:00'))->assertStatus(409)->assertJsonPath('code', 'event_changed');
        $this->assertSame('2027-02-03 11:00:00', $session->fresh()->starts_at->format('Y-m-d H:i:s'));

        $this->patchJson("/api/events/{$session->id}", ['expected_starts_at' => '2027-02-03T11:00:00Z'] + $this->slot('13:00', '14:00'))->assertOk();
        $this->patchJson("/api/events/{$session->id}", $this->slot('15:00', '16:00'))->assertOk();
    }

    public function test_other_users_events_cannot_be_moved_or_deleted(): void
    {
        $stranger = User::factory()->create();
        $theirs = $this->event('Theirs', '09:00', '10:00', '2027-02-03', $stranger);

        $this->patchJson("/api/events/{$theirs->id}", $this->slot('11:00', '12:00'))->assertNotFound();
        $this->deleteJson("/api/events/{$theirs->id}")->assertNotFound();
        $this->putJson("/api/tasks/{$this->task($stranger)->id}/schedule", $this->slot('11:00', '12:00'))->assertNotFound();
        $this->assertSame('2027-02-03 09:00:00', $theirs->fresh()->starts_at->format('Y-m-d H:i:s'));
    }

    public function test_assistant_actions_refuse_overlaps_with_the_structured_conflict_and_undo_never_overwrites_a_taken_slot(): void
    {
        $this->event('Blocker', '09:00', '10:00');
        $task = $this->task(null, 'Plan me');
        $create = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'focus_blocks', 'provider' => 'local', 'summary' => 'x', 'explanation' => [], 'expires_at' => now()->addHour(), 'actions' => [
            ['id' => 'a1', 'type' => 'create_event', 'title' => 'Plan me', 'task_id' => $task->id, 'starts_at' => '2027-02-03T09:30:00+00:00', 'ends_at' => '2027-02-03T10:30:00+00:00', 'minutes' => 60],
        ]]);

        $response = $this->postJson("/api/assistant/proposals/{$create->id}/apply", ['action_ids' => ['a1']]);
        $conflict = $this->assertConflict($response, 'actions');
        $this->assertSame('“Plan me”: now overlaps “Blocker”.', $response->json('errors.actions.0'));
        $this->assertSame('Blocker', $conflict['conflicts'][0]['title']);
        $this->assertSame(['starts_at' => '2027-02-03T10:00:00Z', 'ends_at' => '2027-02-03T11:00:00Z'], $conflict['suggestion']);
        $this->assertSame('pending', $create->fresh()->status);
        $this->assertSame(0, CalendarEvent::where('task_id', $task->id)->count());

        // A move into a taken slot, then an undo whose original slot has been taken in the meantime.
        $movable = $this->event('Movable', '13:00', '14:00', '2027-02-03', null, ['kind' => 'flexible']);
        $move = AssistantProposal::create(['user_id' => $this->user->id, 'kind' => 'rebalance', 'provider' => 'local', 'summary' => 'x', 'explanation' => [], 'expires_at' => now()->addHour(), 'actions' => [
            ['id' => 'm1', 'type' => 'move_event', 'event_id' => $movable->id, 'title' => 'Movable', 'from_starts_at' => '2027-02-03T13:00:00+00:00', 'from_ends_at' => '2027-02-03T14:00:00+00:00', 'starts_at' => '2027-02-03T09:15:00+00:00', 'ends_at' => '2027-02-03T10:15:00+00:00', 'minutes' => 60],
            ['id' => 'm2', 'type' => 'move_event', 'event_id' => $movable->id, 'title' => 'Movable', 'from_starts_at' => '2027-02-03T13:00:00+00:00', 'from_ends_at' => '2027-02-03T14:00:00+00:00', 'starts_at' => '2027-02-03T15:00:00+00:00', 'ends_at' => '2027-02-03T16:00:00+00:00', 'minutes' => 60],
        ]]);
        $this->assertConflict($this->postJson("/api/assistant/proposals/{$move->id}/apply", ['action_ids' => ['m1']]), 'actions');
        $this->postJson("/api/assistant/proposals/{$move->id}/apply", ['action_ids' => ['m2']])->assertOk();
        $this->assertSame('2027-02-03 15:00:00', $movable->fresh()->starts_at->format('Y-m-d H:i:s'));

        $this->event('Took the old slot', '13:00', '14:00');
        $this->postJson("/api/assistant/proposals/{$move->id}/undo")->assertOk();
        $this->assertSame('2027-02-03 15:00:00', $movable->fresh()->starts_at->format('Y-m-d H:i:s'), 'the original time is taken, so the undo keeps the block where it is');
    }

    public function test_accepting_a_plan_refuses_a_block_that_now_overlaps_with_the_structured_conflict(): void
    {
        $task = $this->task(null, 'Planned');
        $blocker = $this->event('Appeared later', '09:30', '10:00');
        $plan = ScheduleProposal::factory()->create(['user_id' => $this->user->id, 'status' => 'pending', 'starts_on' => '2027-02-03', 'days' => 1, 'warnings' => [], 'summary' => [], 'items' => [
            ['key' => "{$task->id}-1", 'task_id' => $task->id, 'task_version' => $task->updated_at->toISOString(), 'title' => 'Planned', 'priority' => 'medium', 'starts_at' => '2027-02-03T09:00:00+00:00', 'ends_at' => '2027-02-03T10:00:00+00:00',
                'minutes' => 60, 'part' => 1, 'parts' => 1, 'manual' => true, 'reasons' => ['manual'], 'explanation' => 'x'],
        ]]);

        $response = $this->postJson("/api/plans/{$plan->id}/accept");
        $conflict = $this->assertConflict($response, 'proposal');

        $this->assertSame('The calendar changed. Generate a new plan to avoid conflicts.', $response->json('message'));
        $this->assertSame($blocker->id, $conflict['conflicts'][0]['event_id']);
        $this->assertSame('pending', $plan->fresh()->status);
        $this->assertSame(0, CalendarEvent::where('task_id', $task->id)->count());
    }

    public function test_the_booking_takes_the_user_lock_before_the_task_lock_and_before_any_calendar_read(): void
    {
        $task = $this->task();
        $queries = [];
        DB::listen(function ($query) use (&$queries) {
            $queries[] = $query->sql;
        });

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('09:00', '10:00'))->assertCreated();

        // The route reads the task once to 404 early; the booking then takes the user row, the task rows and only afterwards reads the calendar.
        $after = fn (string $needle, int $from) => collect($queries)->keys()->first(fn (int $i) => $i >= $from && str_contains($queries[$i], $needle));
        $begin = collect($queries)->search(fn (string $sql) => str_contains($sql, 'from "users"') && str_contains($sql, '"id" = '));
        $this->assertNotFalse($begin);
        $lockedUser = $begin;
        if (DB::getDriverName() === 'pgsql') {
            $lockedUser = collect($queries)->search(fn (string $sql) => str_contains($sql, 'from "users"') && str_contains($sql, 'for no key update'));
            $this->assertNotFalse($lockedUser, 'the user row is locked FOR NO KEY UPDATE');
            $this->assertStringContainsString('for update', $queries[$after('from "tasks"', $lockedUser)], 'then the task row is locked FOR UPDATE');
        }
        $taskRow = $after('from "tasks"', $lockedUser + 1);
        $calendar = $after('from "calendar_events"', $lockedUser + 1);
        $insert = $after('insert into "calendar_events"', $lockedUser + 1);
        $this->assertNotNull($taskRow);
        $this->assertNotNull($calendar);
        $this->assertNotNull($insert);
        $this->assertLessThan($calendar, $taskRow, 'task rows are locked before the calendar is read');
        $this->assertLessThan($insert, $calendar, 'the overlap check reads before the write');
    }

    public function test_two_different_tasks_booked_one_after_the_other_into_the_same_slot_second_is_refused(): void
    {
        $a = $this->task(null, 'Task A');
        $b = $this->task(null, 'Task B');
        $body = $this->slot('09:00', '09:30');

        $this->postJson("/api/tasks/{$a->id}/schedule", $body)->assertCreated();
        $conflict = $this->assertConflict($this->postJson("/api/tasks/{$b->id}/schedule", $body), 'starts_at');

        $this->assertSame('Task A', $conflict['conflicts'][0]['title']);
        $this->assertSame(['starts_at' => '2027-02-03T09:30:00Z', 'ends_at' => '2027-02-03T10:00:00Z'], $conflict['suggestion']);
        $this->assertSame(1, CalendarEvent::count());
    }

    public function test_the_demo_seeder_plants_exactly_one_deliberate_double_booking(): void
    {
        config(['demo.enabled' => true, 'demo.email' => 'demo@lifeos.local', 'demo.timezone' => 'Europe/Amsterdam', 'demo.password' => null]);
        $seeder = new LifeOSDemoSeeder;
        $seeder->language = 'en';
        $seeder->password = 'demo-password-123';
        $seeder->setContainer($this->app)->__invoke();
        $demo = User::where('email', 'demo@lifeos.local')->sole();

        $from = now()->subDays(30);
        $to = now()->addDays(60);
        $occurrences = app(CalendarService::class)->occurrences($demo, $from->toImmutable(), $to->toImmutable())->values();
        $clashes = [];
        foreach ($occurrences as $i => $a) {
            foreach ($occurrences->slice($i + 1) as $b) {
                if (CalendarService::overlaps($b, $a['starts_at'], $a['ends_at'])) {
                    $clashes[] = "{$a['title']} / {$b['title']} at {$a['starts_at']->toIso8601String()}";
                }
            }
        }
        // The seeder writes straight to the table (it is not a user path) and plants exactly one deliberate double booking for the conflict demo.
        $this->assertCount(1, $clashes, implode('; ', $clashes));
        $this->assertStringStartsWith('Doctor appointment / Vendor call', $clashes[0]);
    }

    public function test_the_session_title_comes_from_the_task_row_read_under_the_lock(): void
    {
        $task = $this->task(null, 'Old name');
        $renamed = false;
        DB::listen(function ($query) use (&$renamed, $task) {
            // The first read of the user row after the early task read is the booking lock: rename the task right then, as a concurrent edit would.
            if (! $renamed && str_contains($query->sql, 'from "users"')) {
                $renamed = true;
                DB::table('tasks')->where('id', $task->id)->update(['title' => 'New name']);
            }
        });

        $this->postJson("/api/tasks/{$task->id}/schedule", $this->slot('09:00', '10:00'))->assertCreated()->assertJsonPath('data.title', 'New name');
        $this->assertTrue($renamed);
        $this->assertSame('New name', CalendarEvent::firstOrFail()->title);
    }

    public function test_expected_starts_at_also_guards_a_single_occurrence_and_a_series(): void
    {
        $series = $this->event('Standup', '09:00', '09:30', '2027-02-03', null, ['recurrence' => ['freq' => 'daily', 'interval' => 1], 'timezone' => 'UTC', 'kind' => 'flexible']);
        $occurrence = ['scope' => 'occurrence', 'occurrence_start' => '2027-02-04T09:00:00Z'];

        $this->patchJson("/api/events/{$series->id}", $occurrence + ['expected_starts_at' => '2027-02-04T10:00:00Z'] + $this->slot('11:00', '11:30', '2027-02-04'))->assertStatus(409)
            ->assertJsonPath('code', 'event_changed')->assertJsonPath('current.starts_at', '2027-02-04T09:00:00Z');
        $this->assertSame(0, CalendarEventException::count());
        $this->patchJson("/api/events/{$series->id}", $occurrence + ['expected_starts_at' => '2027-02-04T09:00:00Z'] + $this->slot('11:00', '11:30', '2027-02-04'))->assertOk();
        // The occurrence now starts at 11:00, so a tab that still sees 09:00 is stale.
        $this->patchJson("/api/events/{$series->id}", $occurrence + ['expected_starts_at' => '2027-02-04T09:00:00Z'] + $this->slot('12:00', '12:30', '2027-02-04'))->assertStatus(409)->assertJsonPath('current.starts_at', '2027-02-04T11:00:00Z');
        // A series is compared with its own first start.
        $this->patchJson("/api/events/{$series->id}", ['expected_starts_at' => '2027-02-04T09:00:00Z', 'title' => 'x'])->assertStatus(409);
        $this->patchJson("/api/events/{$series->id}", ['expected_starts_at' => '2027-02-03T09:00:00Z', 'title' => 'Daily standup'])->assertOk();
    }

    public function test_the_future_session_of_a_closed_task_is_not_moved_by_patch_either_but_can_still_be_renamed_or_deleted(): void
    {
        foreach (['completed', 'cancelled'] as $status) {
            $task = $this->task(null, "Closed {$status}", ['status' => $status]);
            $session = $this->bookedSession($task, '09:00', '10:00', $status === 'completed' ? '2027-02-03' : '2027-02-04');
            $day = $status === 'completed' ? '2027-02-03' : '2027-02-04';

            $this->patchJson("/api/events/{$session->id}", $this->slot('11:00', '12:00', $day))->assertUnprocessable()->assertJsonValidationErrors('task');
            $this->putJson("/api/tasks/{$task->id}/schedule", $this->slot('11:00', '12:00', $day))->assertUnprocessable()->assertJsonValidationErrors('task');
            $this->assertSame("{$day} 09:00:00", $session->fresh()->starts_at->format('Y-m-d H:i:s'));

            $this->patchJson("/api/events/{$session->id}", ['title' => 'Retitled', 'kind' => 'fixed', 'confirm_fixed' => true])->assertOk();
            $this->deleteJson("/api/events/{$session->id}")->assertOk();
        }
    }

    public function test_a_work_window_that_ends_before_it_starts_yields_no_suggestion_and_fractional_seconds_never_reach_it(): void
    {
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'UTC', 'work_start' => '17:00', 'work_end' => '09:00']]);
        $this->event('Busy', '09:00', '10:00');
        $this->assertNull($this->assertConflict($this->postJson('/api/events', ['title' => 'X'] + $this->slot('09:30', '10:30')), 'starts_at')['suggestion']);

        UserSetting::query()->update(['preferences' => ['timezone' => 'UTC']]);
        CalendarEvent::query()->delete();
        $this->external('Half second', '09:00', '09:30');
        ExternalEvent::query()->update(['ends_at' => '2027-02-03 09:30:00.500000']);
        $suggestion = $this->assertConflict($this->postJson('/api/events', ['title' => 'X'] + $this->slot('09:15', '09:45')), 'starts_at')['suggestion'];
        $this->assertSame('2027-02-03T09:30:01Z', $suggestion['starts_at']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', $suggestion['ends_at']);
    }
}
