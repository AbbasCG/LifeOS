<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Two DIFFERENT tasks can never hold the same time. Task A owns 09:00-10:00; task B asks for a time on every path that books or moves a
 * session (one-step create, one-step update, POST /schedule). The half-open rule decides: touching ends are fine, one minute of overlap is not.
 *
 * "Now" is Monday 2027-02-01 08:00 UTC; the user has no settings (UTC).
 */
class CrossTaskConflictTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private Task $a;

    private CalendarEvent $aSession;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        $this->travelTo(CarbonImmutable::parse('2027-02-01 08:00', 'UTC'));
        $this->user = User::factory()->create();
        $this->actingAs($this->user);
        $this->a = $this->task('Task A');
        $this->aSession = $this->booked($this->a, '09:00', '10:00');
    }

    private function at(string $time): string
    {
        return "2027-02-03T{$time}:00Z";
    }

    private function task(string $title, string $status = 'todo'): Task
    {
        return Task::factory()->create(['user_id' => $this->user->id, 'title' => $title, 'estimated_minutes' => 30, 'status' => $status, 'priority' => 'medium', 'due_at' => '2027-02-10 12:00:00']);
    }

    private function booked(Task $task, string $from, string $to): CalendarEvent
    {
        return CalendarEvent::factory()->create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => $task->title, 'kind' => 'flexible', 'starts_at' => "2027-02-03 {$from}:00", 'ends_at' => "2027-02-03 {$to}:00"]);
    }

    /** @return array<string, array{0: string, 1: int, 2: bool, 3: int}> start, minutes, free?, overlap minutes when refused */
    public static function shapes(): array
    {
        return [
            'identical slot' => ['09:00', 60, false, 60],
            'same start, shorter' => ['09:00', 30, false, 30],
            'starts inside, ends inside' => ['09:15', 30, false, 30],
            'starts before, ends inside' => ['08:45', 30, false, 15],
            'starts inside, ends after' => ['09:45', 30, false, 15],
            'covers the whole of A' => ['08:30', 120, false, 60],
            'one minute into A from before' => ['08:31', 30, false, 1],
            'one minute into A from after' => ['09:59', 30, false, 1],
            'ends exactly where A starts' => ['08:30', 30, true, 0],
            'starts exactly where A ends' => ['10:00', 30, true, 0],
            'well after A' => ['14:00', 30, true, 0],
        ];
    }

    /** @return array<string, array{0: string}> */
    public static function closedStates(): array
    {
        return ['completed' => ['completed'], 'cancelled' => ['cancelled']];
    }

    #[DataProvider('shapes')]
    public function test_a_new_task_booked_in_one_step_against_another_tasks_session(string $start, int $minutes, bool $free, int $overlap): void
    {
        $body = ['title' => 'Task B', 'estimated_minutes' => $minutes, 'schedule' => ['starts_at' => $this->at($start)]];
        $response = $this->postJson('/api/tasks', $body);

        if ($free) {
            $response->assertCreated();
            $this->assertSame(2, CalendarEvent::count());

            return;
        }
        $response->assertUnprocessable()->assertJsonPath('conflict.code', 'schedule_conflict')
            ->assertJsonPath('conflict.conflicts.0.task_id', $this->a->id)->assertJsonPath('conflict.conflicts.0.title', 'Task A')
            ->assertJsonPath('conflict.conflicts.0.event_id', $this->aSession->id)->assertJsonPath('conflict.conflicts.0.overlap_minutes', $overlap);
        $this->assertSame(0, Task::where('title', 'Task B')->count(), 'the refused task is not left behind');
        $this->assertSame(1, CalendarEvent::count());
    }

    #[DataProvider('shapes')]
    public function test_moving_an_existing_task_against_another_tasks_session_keeps_its_old_session_when_refused(string $start, int $minutes, bool $free, int $overlap): void
    {
        $b = $this->task('Task B');
        $old = $this->booked($b, '13:00', '13:30');
        $response = $this->patchJson("/api/tasks/{$b->id}", ['estimated_minutes' => $minutes, 'schedule' => ['starts_at' => $this->at($start)]]);

        if ($free) {
            $response->assertOk()->assertJsonPath('data.schedule.starts_at', $this->at($start));
            $this->assertSame(2, CalendarEvent::count(), 'moved, not copied');

            return;
        }
        $response->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.task_id', $this->a->id)->assertJsonPath('conflict.conflicts.0.overlap_minutes', $overlap);
        $this->assertSame('2027-02-03 13:00:00', CalendarEvent::findOrFail($old->id)->starts_at->format('Y-m-d H:i:s'));
        $this->assertSame(30, Task::findOrFail($b->id)->estimated_minutes, 'the refused estimate was not saved either');
    }

    #[DataProvider('shapes')]
    public function test_the_schedule_endpoint_refuses_the_same_shapes(string $start, int $minutes, bool $free, int $overlap): void
    {
        $b = $this->task('Task B');
        $end = CarbonImmutable::parse("2027-02-03 {$start}", 'UTC')->addMinutes($minutes)->format('Y-m-d\TH:i:s\Z');
        $response = $this->postJson("/api/tasks/{$b->id}/schedule", ['starts_at' => $this->at($start), 'ends_at' => $end], ['Idempotency-Key' => "k-{$start}-{$minutes}"]);

        if ($free) {
            $response->assertCreated();

            return;
        }
        $response->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.task_id', $this->a->id);
        $this->assertSame(0, CalendarEvent::where('task_id', $b->id)->count());
    }

    public function test_the_refusal_suggests_a_free_time_that_is_itself_accepted(): void
    {
        $response = $this->postJson('/api/tasks', ['title' => 'Task B', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('09:15')]])->assertUnprocessable();
        $suggestion = $response->json('conflict.suggestion.starts_at');
        $this->assertNotNull($suggestion);
        $this->assertGreaterThanOrEqual($this->at('10:00'), $suggestion, 'never inside A');

        $this->postJson('/api/tasks', ['title' => 'Task B', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $suggestion]])->assertCreated();
    }

    public function test_a_request_over_several_tasks_lists_every_one_of_them(): void
    {
        $c = $this->task('Task C');
        $this->booked($c, '10:00', '11:00');
        $response = $this->postJson('/api/tasks', ['title' => 'Task B', 'estimated_minutes' => 120, 'schedule' => ['starts_at' => $this->at('09:00')]])->assertUnprocessable();

        $this->assertSame(['Task A', 'Task C'], collect($response->json('conflict.conflicts'))->pluck('title')->all(), 'earliest first');
        $this->assertSame([$this->a->id, $c->id], collect($response->json('conflict.conflicts'))->pluck('task_id')->all());
    }

    public function test_two_tasks_cannot_swap_into_each_others_slot_in_one_move(): void
    {
        $b = $this->task('Task B');
        $bSession = $this->booked($b, '10:00', '11:00');

        $this->patchJson("/api/tasks/{$b->id}", ['schedule' => ['starts_at' => $this->at('09:00')]])->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.task_id', $this->a->id);
        $this->patchJson("/api/tasks/{$this->a->id}", ['schedule' => ['starts_at' => $this->at('10:00')]])->assertUnprocessable()->assertJsonPath('conflict.conflicts.0.task_id', $b->id);

        $this->assertSame('2027-02-03 09:00:00', CalendarEvent::findOrFail($this->aSession->id)->starts_at->format('Y-m-d H:i:s'));
        $this->assertSame('2027-02-03 10:00:00', CalendarEvent::findOrFail($bSession->id)->starts_at->format('Y-m-d H:i:s'));
    }

    public function test_a_chain_of_adjacent_tasks_fills_the_day_without_gaps_or_overlaps(): void
    {
        $starts = ['10:00', '10:30', '11:00', '11:30'];
        foreach ($starts as $i => $time) {
            $this->postJson('/api/tasks', ['title' => "Chain {$i}", 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at($time)]])->assertCreated();
        }
        $rows = CalendarEvent::orderBy('starts_at')->get();
        $this->assertCount(5, $rows);
        foreach ($rows as $i => $row) {
            if ($i > 0) {
                $this->assertLessThanOrEqual($row->starts_at->getTimestamp(), $rows[$i - 1]->ends_at->getTimestamp(), 'no overlap between neighbours');
            }
        }
        $this->postJson('/api/tasks', ['title' => 'One too many', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('11:15')]])->assertUnprocessable();
        $this->assertCount(5, CalendarEvent::all());
    }

    #[DataProvider('closedStates')]
    public function test_the_time_of_a_closed_task_is_free_for_another_and_comes_back_when_it_is_reopened(string $closed): void
    {
        $this->a->update(['status' => $closed]);
        $this->postJson('/api/tasks', ['title' => 'Task B', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('09:00')]])->assertCreated();

        // Reopening A would now double-book B's time; the session stays on the calendar and the refusal is on the next change to it.
        $this->patchJson("/api/tasks/{$this->a->id}", ['status' => 'todo'])->assertOk();
        $this->postJson('/api/tasks', ['title' => 'Task C', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('09:10')]])->assertUnprocessable()
            ->assertJsonPath('conflict.conflicts.0.title', fn ($title) => in_array($title, ['Task A', 'Task B'], true));
    }

    public function test_another_users_task_at_the_same_time_never_blocks_or_appears(): void
    {
        $other = User::factory()->create();
        $theirs = Task::factory()->create(['user_id' => $other->id, 'title' => 'Their secret', 'estimated_minutes' => 60, 'status' => 'todo', 'priority' => 'medium']);
        CalendarEvent::factory()->create(['user_id' => $other->id, 'task_id' => $theirs->id, 'title' => 'Their secret', 'kind' => 'flexible', 'starts_at' => '2027-02-03 14:00:00', 'ends_at' => '2027-02-03 15:00:00']);

        $this->postJson('/api/tasks', ['title' => 'Task B', 'estimated_minutes' => 60, 'schedule' => ['starts_at' => $this->at('14:00')]])->assertCreated();
        $clash = $this->postJson('/api/tasks', ['title' => 'Task C', 'estimated_minutes' => 30, 'schedule' => ['starts_at' => $this->at('14:30')]])->assertUnprocessable();
        $this->assertStringNotContainsString('Their secret', $clash->getContent());
    }
}
