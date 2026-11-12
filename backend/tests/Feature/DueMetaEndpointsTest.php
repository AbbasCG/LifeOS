<?php

namespace Tests\Feature;

use App\Models\InboxNotification;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Every response that emits a task's due_at also carries due_all_day and due_date (account zone), so a clock can be hidden for date-only
 * deadlines without guessing from 23:59: a genuinely timed 23:59 task must come back with due_all_day = false.
 */
class DueMetaEndpointsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private Task $dateOnly;

    private Task $timed2359;

    protected function setUp(): void
    {
        parent::setUp();
        config(['ai.provider' => 'disabled']);
        // Tuesday 12 Jan 2027, 10:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2027-01-12 10:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'break_minutes' => 10, 'work_days' => [1, 2, 3, 4, 5]]]);
        $this->dateOnly = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Date only', 'status' => 'todo', 'priority' => 'urgent', 'estimated_minutes' => 60,
            'due_at' => Task::endOfDay('2027-01-13', 'Europe/Amsterdam'), 'due_all_day' => true]);
        // Same instant of day, but the person typed 23:59: a real time.
        $this->timed2359 = Task::factory()->create(['user_id' => $this->user->id, 'title' => 'Timed late', 'status' => 'todo', 'priority' => 'urgent', 'estimated_minutes' => 60,
            'due_at' => Task::endOfDay('2027-01-13', 'Europe/Amsterdam'), 'due_all_day' => false]);
        $this->actingAs($this->user);
    }

    /** Assert that every task row (found by id) in $rows carries the right pair. */
    private function assertMeta(iterable $rows, string $idKey = 'id'): void
    {
        $seen = [];
        foreach ($rows as $row) {
            if (($row['type'] ?? 'task') !== 'task' && isset($row['type'])) {
                continue;
            }
            $id = $row[$idKey] ?? null;
            if ($id === $this->dateOnly->id) {
                $this->assertTrue($row['due_all_day'], 'date-only row: '.json_encode($row));
                $this->assertSame('2027-01-13', $row['due_date']);
                $seen['d'] = true;
            } elseif ($id === $this->timed2359->id) {
                $this->assertFalse($row['due_all_day'], 'timed 23:59 row: '.json_encode($row));
                $this->assertNull($row['due_date']);
                $seen['t'] = true;
            }
        }
        $this->assertSame(['d' => true, 't' => true], $seen);
    }

    public function test_today_deadlines(): void
    {
        $this->assertMeta($this->getJson('/api/today')->assertOk()->json('deadlines'));
    }

    public function test_briefing_focus(): void
    {
        $this->assertMeta($this->getJson('/api/briefing')->assertOk()->json('focus'));
    }

    public function test_intelligence_briefing_priorities(): void
    {
        $json = $this->getJson('/api/intelligence/briefing')->assertOk()->json();
        $this->assertMeta($json['priorities'] ?? []);
    }

    public function test_weekly_review_unfinished_and_suggested(): void
    {
        $r = $this->getJson('/api/reviews/2027-01-11')->assertOk()->json();
        $this->assertMeta($r['unfinished'] ?? []);
        $this->assertMeta($r['suggested_priorities'] ?? []);
    }

    public function test_timeline_task_marker_is_all_day_only_for_date_only_deadlines(): void
    {
        $items = collect($this->getJson('/api/timeline?from=2027-01-13&to=2027-01-13')->assertOk()->json('items'));
        $d = $items->firstWhere('id', 'task:'.$this->dateOnly->id);
        $t = $items->firstWhere('id', 'task:'.$this->timed2359->id);
        $this->assertTrue($d['all_day']);
        $this->assertTrue($d['due_all_day']);
        $this->assertSame('2027-01-13', $d['due_date']);
        $this->assertFalse($t['all_day']);
        $this->assertFalse($t['due_all_day']);
        $this->assertNull($t['due_date']);
    }

    public function test_assistant_task_summaries(): void
    {
        $tasks = $this->postJson('/api/assistant', ['message' => 'What should I focus on today?', 'language' => 'en'])->assertOk()->json('tasks');
        $this->assertMeta($tasks);
    }

    public function test_triage_proposal_actions_carry_the_source_deadline_kind(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-01-14 10:00', 'Europe/Amsterdam'));
        $actions = collect($this->postJson('/api/assistant', ['message' => 'Reschedule my overdue tasks', 'language' => 'en'])->assertOk()->json('proposal.actions'));
        $byTask = $actions->keyBy('task_id');
        $this->assertTrue($byTask[$this->dateOnly->id]['from_due_all_day']);
        $this->assertSame('2027-01-13', $byTask[$this->dateOnly->id]['from_due_date']);
        $this->assertFalse($byTask[$this->timed2359->id]['from_due_all_day']);
        $this->assertNull($byTask[$this->timed2359->id]['from_due_date']);
        $this->assertFalse($byTask[$this->dateOnly->id]['due_all_day'], 'the proposed new deadline has a time');
    }

    public function test_texts_for_date_only_deadlines_never_print_a_clock(): void
    {
        $msg = $this->postJson('/api/assistant', ['message' => 'What should I focus on today?', 'language' => 'en'])->json('message');
        $this->assertStringNotContainsString('23:59', $msg);
        $this->travelTo(CarbonImmutable::parse('2027-01-14 10:00', 'Europe/Amsterdam'));
        $overdue = $this->postJson('/api/assistant', ['message' => 'What is overdue?', 'language' => 'en'])->json('message');
        $this->assertStringContainsString('Date only — 2027-01-13', $overdue);
        $this->assertStringNotContainsString('Date only — 2027-01-13 23:59', $overdue);
        $this->assertStringContainsString('Timed late — 2027-01-13 23:59', $overdue);
    }

    public function test_deadline_notification_says_today_or_the_date_never_a_time(): void
    {
        $this->travelTo(CarbonImmutable::parse('2027-01-13 23:30', 'Europe/Amsterdam'));
        $this->artisan('lifeos:reminders')->assertSuccessful();
        $titles = InboxNotification::where('user_id', $this->user->id)->pluck('title', 'link');
        $this->assertSame('Due today: Date only', $titles["/tasks?task={$this->dateOnly->id}"]);
        $this->assertSame('Task due: Timed late', $titles["/tasks?task={$this->timed2359->id}"]);
    }
}
