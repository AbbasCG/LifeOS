<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Webhooks\WebhookEndpointService;
use App\Integrations\Webhooks\WebhookVerifier;
use App\Models\CalendarEvent;
use App\Models\FocusSession;
use App\Models\InboxNotification;
use App\Models\IntegrationLink;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Models\WebhookDelivery;
use App\Models\WebhookEndpoint;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * EMC ticket events end to end: signed request -> receiver -> queued job (synchronous here) -> EmcWebhookHandler -> task and link.
 * The contract is docs/EMC_INTEGRATION.md. "Now" is Thursday 2026-11-26 10:00 UTC; the owner's account timezone is Europe/Amsterdam.
 */
class EmcWebhookTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    private WebhookEndpoint $endpoint;

    private string $secret;

    private int $sequence = 0;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2026-11-26 10:00', 'UTC'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'language' => 'en']]);
        ['endpoint' => $this->endpoint, 'secret' => $this->secret] = app(WebhookEndpointService::class)->create('emc', $this->user, 'EMC', requireEventId: true, accountKey: 'default');
    }

    /**
     * @param  array<string, mixed>  $ticket  overrides of the ticket snapshot
     * @param  array<string, mixed>  $top  overrides of the top-level fields
     */
    private function event(string $type, int $version, array $ticket = [], array $top = []): array
    {
        $id = $top['event_id'] ?? 'evt-'.(++$this->sequence).'-v'.$version;

        return array_merge(['schema_version' => 1, 'event_id' => $id, 'type' => $type, 'occurred_at' => now()->toIso8601ZuluString()], $top, ['ticket' => array_merge([
            'external_id' => 'T-1042', 'version' => $version, 'title' => 'Replace the meeting-room display', 'priority' => 'high',
            'due_at' => '2026-12-01T17:00:00+01:00', 'due_date' => null, 'url' => 'https://emc.example.com/tickets/T-1042', 'assignee_id' => 'emc-user-42',
        ], $ticket)]);
    }

    /** Send a signed delivery exactly as EMC would. */
    private function deliver(array $body, ?WebhookEndpoint $endpoint = null, ?string $secret = null, ?string $delivery = null, ?string $raw = null)
    {
        $raw ??= json_encode($body, JSON_UNESCAPED_SLASHES);
        $timestamp = now()->getTimestamp();
        $endpoint ??= $this->endpoint;

        return $this->call('POST', '/api/webhooks/'.$endpoint->public_id, [], [], [], [
            'CONTENT_TYPE' => 'application/json',
            'HTTP_X_LIFEOS_TIMESTAMP' => (string) $timestamp,
            'HTTP_X_LIFEOS_SIGNATURE' => WebhookVerifier::sign($secret ?? $this->secret, $timestamp, $raw),
            'HTTP_X_LIFEOS_DELIVERY' => $delivery ?? ($body['event_id'] ?? 'missing'),
        ], $raw);
    }

    private function task(): ?Task
    {
        return Task::where('user_id', $this->user->id)->where('source_ref', 'emc:default:T-1042')->first();
    }

    private function link(): IntegrationLink
    {
        return IntegrationLink::where('user_id', $this->user->id)->where('external_id', 'T-1042')->sole();
    }

    private function deliveryStatus(string $eventId): ?string
    {
        return WebhookDelivery::where('delivery_id', $eventId)->value('status');
    }

    // ---- creating the task ----------------------------------------------------------------------------------------------------------

    public function test_an_assigned_ticket_creates_one_unscheduled_inbox_task_with_the_ticket_data(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202)->assertJson(['status' => 'accepted']);

        $task = $this->task();
        $this->assertNotNull($task);
        $this->assertSame(
            ['Replace the meeting-room display', 'inbox', 'high', ['emc'], null, null, null, false, 'EMC ticket T-1042: https://emc.example.com/tickets/T-1042'],
            [$task->title, $task->status, $task->priority, $task->tags, $task->scheduled_start, $task->scheduled_end, $task->remind_at, $task->due_all_day, $task->description],
        );
        $this->assertTrue($task->due_at->equalTo(CarbonImmutable::parse('2026-12-01 16:00', 'UTC')));
        $this->assertSame(0, CalendarEvent::count(), 'no calendar session is created');
        $link = $this->link();
        $this->assertSame([$task->id, 1, 'assigned', 'evt-1-v1', $this->endpoint->id, 'default'], [$link->task_id, $link->version, $link->remote_state, $link->last_event_id, $link->webhook_endpoint_id, $link->account_key]);
        $this->assertSame('processed', $this->deliveryStatus('evt-1-v1'));
    }

    public function test_the_task_is_in_the_inbox_lists_and_has_no_schedule_in_the_api(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);

        $this->actingAs($this->user)->getJson('/api/tasks?status=inbox')->assertOk()
            ->assertJsonPath('data.0.title', 'Replace the meeting-room display')->assertJsonPath('data.0.schedule', null);
    }

    public function test_a_date_only_deadline_is_the_end_of_that_day_in_the_owners_timezone(): void
    {
        $this->deliver($this->event('ticket.assigned', 1, ['due_at' => null, 'due_date' => '2026-12-03']))->assertStatus(202);

        $task = $this->task();
        $this->assertTrue($task->due_all_day);
        $this->assertTrue($task->due_at->equalTo(CarbonImmutable::parse('2026-12-03 23:59', 'Europe/Amsterdam')));
    }

    public function test_no_deadline_and_priority_mapping(): void
    {
        foreach (['T-1' => ['low', 'low'], 'T-2' => ['Normal', 'medium'], 'T-3' => ['CRITICAL', 'urgent'], 'T-4' => ['p1-whatever', 'medium']] as $id => [$emc, $lifeos]) {
            $this->deliver($this->event('ticket.assigned', 1, ['external_id' => $id, 'priority' => $emc, 'due_at' => null]))->assertStatus(202);
            $task = Task::where('source_ref', "emc:default:{$id}")->sole();
            $this->assertSame([$lifeos, null], [$task->priority, $task->due_at], $id);
        }
    }

    public function test_a_long_title_is_cut_and_control_characters_are_removed(): void
    {
        $this->deliver($this->event('ticket.assigned', 1, ['title' => "Line one\nline two\t".str_repeat('x', 400)]))->assertStatus(202);

        $title = $this->task()->title;
        $this->assertSame(200, mb_strlen($title));
        $this->assertStringStartsWith('Line one line two x', $title);
    }

    public function test_invisible_and_direction_changing_characters_are_removed_from_the_title(): void
    {
        $this->deliver($this->event('ticket.assigned', 1, ['title' => "Pay\u{202E}reviled\u{202C} invoice\u{200B} 42\u{0085}now  "]))->assertStatus(202);

        $this->assertSame('Payreviled invoice 42 now', $this->task()->title);
    }

    public function test_a_title_cut_at_200_characters_never_ends_in_a_space_so_the_merge_keeps_working(): void
    {
        $title = str_repeat('a', 199).' tail';
        $this->deliver($this->event('ticket.assigned', 1, ['title' => $title]))->assertStatus(202);
        $this->assertSame(str_repeat('a', 199), $this->task()->title);
        $this->actingAs($this->user)->patchJson('/api/tasks/'.$this->task()->id, ['title' => $this->task()->title.' '])->assertOk();   // a client echo, trimmed by Laravel

        $this->deliver($this->event('ticket.updated', 2, ['title' => 'Renamed in EMC']))->assertStatus(202);
        $this->assertSame('Renamed in EMC', $this->task()->title);
    }

    public function test_an_unsafe_link_is_dropped_but_the_event_applies(): void
    {
        config(['integrations.emc.allowed_url_hosts' => ['emc.example.com']]);
        foreach (['T-a' => 'http://emc.example.com/t', 'T-b' => 'javascript:alert(1)', 'T-c' => 'https://evil.example.org/t', 'T-d' => 'https://user:pass@emc.example.com/t'] as $id => $url) {
            $this->deliver($this->event('ticket.assigned', 1, ['external_id' => $id, 'url' => $url]))->assertStatus(202);
            $this->assertSame("EMC ticket {$id}", Task::where('source_ref', "emc:default:{$id}")->value('description'), $url);
            $this->assertNull(IntegrationLink::where('external_id', $id)->value('remote_url'));
        }
    }

    // ---- duplicates and ordering ---------------------------------------------------------------------------------------------------

    public function test_a_redelivered_event_and_a_replay_with_another_delivery_id_create_nothing_more(): void
    {
        $body = $this->event('ticket.assigned', 1);
        $this->deliver($body)->assertJson(['status' => 'accepted']);
        $this->deliver($body)->assertStatus(202)->assertJson(['status' => 'duplicate']);
        $this->deliver($body, delivery: 'evt-forged')->assertStatus(400);

        $this->assertSame(1, Task::count());
        $this->assertSame(1, WebhookDelivery::count());
    }

    public function test_one_task_per_ticket_even_when_several_events_create_it(): void
    {
        $this->deliver($this->event('ticket.updated', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 2))->assertStatus(202);
        $this->deliver($this->event('ticket.updated', 3))->assertStatus(202);

        $this->assertSame(1, Task::where('source_ref', 'emc:default:T-1042')->count());
        $this->assertSame(1, IntegrationLink::count());
    }

    public function test_an_older_or_equal_version_arriving_late_is_ignored(): void
    {
        $this->deliver($this->event('ticket.assigned', 3, ['title' => 'Version three']))->assertStatus(202);
        $this->deliver($this->event('ticket.updated', 2, ['title' => 'Version two']))->assertStatus(202);
        $this->deliver($this->event('ticket.closed', 3, ['title' => 'Also three']))->assertStatus(202);

        $this->assertSame(['Version three', 'inbox'], [$this->task()->title, $this->task()->status]);
        $this->assertSame([3, 'assigned'], [$this->link()->version, $this->link()->remote_state]);
        $this->assertSame('processed', $this->deliveryStatus('evt-2-v2'), 'a stale event is still recorded as handled');
    }

    public function test_a_close_that_overtakes_the_assignment_never_creates_the_task(): void
    {
        $this->deliver($this->event('ticket.closed', 2))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);

        $this->assertNull($this->task());
        $this->assertSame([2, 'closed', null], [$this->link()->version, $this->link()->remote_state, $this->link()->task_id]);
    }

    // ---- updates: EMC fields only, never the person's own data --------------------------------------------------------------------

    public function test_an_update_syncs_title_priority_and_deadline_and_leaves_everything_personal_alone(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $task = $this->task();
        $task->forceFill(['notes' => 'Ask facilities first', 'description' => 'My own words', 'estimated_minutes' => 90, 'subtasks' => [['title' => 'Order cable', 'completed' => true]], 'tags' => ['emc', 'office'], 'status' => 'in_progress'])->save();
        $session = CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => $task->title, 'kind' => 'flexible', 'starts_at' => '2026-11-27 09:00:00', 'ends_at' => '2026-11-27 10:30:00']);
        $focus = FocusSession::factory()->create(['user_id' => $this->user->id, 'task_id' => $task->id]);
        $before = $task->fresh();

        $this->deliver($this->event('ticket.updated', 2, ['title' => 'Replace the display in room 4', 'priority' => 'urgent', 'due_at' => '2026-12-02T12:00:00Z']))->assertStatus(202);

        $after = $task->fresh();
        $this->assertSame(['Replace the display in room 4', 'urgent'], [$after->title, $after->priority]);
        $this->assertTrue($after->due_at->equalTo(CarbonImmutable::parse('2026-12-02 12:00', 'UTC')));
        $this->assertSame(
            [$before->notes, $before->description, $before->estimated_minutes, $before->subtasks, $before->tags, $before->status, $before->scheduled_start, 0, null],
            [$after->notes, $after->description, $after->estimated_minutes, $after->subtasks, $after->tags, $after->status, $after->scheduled_start, $after->postponed_count, $after->last_postponed_at],
            'personal fields untouched, and an EMC deadline move is not a postponement',
        );
        $this->assertSame([$task->id, '2026-11-27 09:00:00'], [$session->fresh()->task_id, $session->fresh()->starts_at->format('Y-m-d H:i:s')]);
        $this->assertSame($task->id, $focus->fresh()->task_id);
    }

    public function test_a_field_the_person_changed_is_kept_while_the_others_still_sync(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->actingAs($this->user)->patchJson('/api/tasks/'.$this->task()->id, ['title' => 'Display: my own title', 'due_date' => '2026-12-10'])->assertOk();

        $this->deliver($this->event('ticket.updated', 2, ['title' => 'EMC renamed it', 'priority' => 'low', 'due_at' => '2026-12-05T09:00:00Z']))->assertStatus(202);

        $task = $this->task();
        $this->assertSame(['Display: my own title', 'low', true], [$task->title, $task->priority, $task->due_all_day]);
        $this->assertSame('2026-12-10', $task->dueDate('Europe/Amsterdam'));
        $this->assertSame('EMC renamed it', $this->link()->remote_title, 'what EMC sent is still recorded');

        // Once the person puts EMC's value back, later updates flow again.
        $this->actingAs($this->user)->patchJson('/api/tasks/'.$task->id, ['title' => 'EMC renamed it'])->assertOk();
        $this->deliver($this->event('ticket.updated', 3, ['title' => 'EMC renamed it again', 'priority' => 'low', 'due_at' => '2026-12-05T09:00:00Z']))->assertStatus(202);
        $this->assertSame('EMC renamed it again', $this->task()->title);
    }

    public function test_a_priority_the_person_changed_is_kept(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->actingAs($this->user)->patchJson('/api/tasks/'.$this->task()->id, ['priority' => 'low'])->assertOk();
        $this->deliver($this->event('ticket.updated', 2, ['priority' => 'urgent', 'title' => 'New title']))->assertStatus(202);

        $this->assertSame(['low', 'New title'], [$this->task()->priority, $this->task()->title]);
    }

    public function test_an_existing_task_with_the_reference_is_reused_when_the_link_is_missing(): void
    {
        $mine = Task::create(['user_id' => $this->user->id, 'title' => 'Restored earlier', 'status' => 'todo', 'source_ref' => 'emc:default:T-1042', 'notes' => 'Keep']);

        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);

        $this->assertSame(1, Task::count());
        $this->assertSame([$mine->id, 'Keep'], [$this->link()->task_id, $mine->fresh()->notes]);
    }

    public function test_removing_the_deadline_in_emc_removes_it_when_the_person_kept_emcs_deadline(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.updated', 2, ['due_at' => null]))->assertStatus(202);

        $this->assertNull($this->task()->due_at);
        $this->assertFalse($this->task()->due_all_day);
    }

    // ---- closing, unassigning, reassigning ------------------------------------------------------------------------------------------

    public function test_closing_completes_the_task_and_keeps_its_sessions_and_never_creates_a_next_occurrence(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $task = $this->task();
        $task->forceFill(['recurrence' => 'daily', 'notes' => 'Keep me'])->save();
        $session = CalendarEvent::create(['user_id' => $this->user->id, 'task_id' => $task->id, 'title' => $task->title, 'kind' => 'flexible', 'starts_at' => '2026-11-27 09:00:00', 'ends_at' => '2026-11-27 10:00:00']);
        $focus = FocusSession::factory()->create(['user_id' => $this->user->id, 'task_id' => $task->id, 'elapsed_seconds' => 1500]);

        $this->deliver($this->event('ticket.closed', 2))->assertStatus(202);

        $task->refresh();
        $this->assertSame(['completed', 'Keep me'], [$task->status, $task->notes]);
        $this->assertNotNull($task->completed_at);
        $this->assertSame(1, Task::count(), 'no next occurrence for a closed ticket');
        $this->assertSame([$task->id, $task->id], [$session->fresh()->task_id, $focus->fresh()->task_id]);
        $this->assertTrue($this->link()->closed_by_sync);
    }

    public function test_reassigning_a_ticket_closed_by_emc_reopens_the_task_but_a_task_the_person_completed_stays_completed(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.closed', 2))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 3))->assertStatus(202);
        $this->assertSame(['inbox', null], [$this->task()->status, $this->task()->completed_at], 'reopened into the Inbox: not looked at yet');
        $this->assertFalse($this->link()->closed_by_sync);

        $this->actingAs($this->user)->patchJson('/api/tasks/'.$this->task()->id, ['status' => 'completed'])->assertOk();
        $this->deliver($this->event('ticket.closed', 4))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 5))->assertStatus(202);
        $this->assertSame('completed', $this->task()->status, 'the person completed it themselves');
        $this->assertSame(1, Task::count());
    }

    public function test_an_edit_to_a_closed_ticket_does_not_reopen_the_task_only_a_new_assignment_does(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.closed', 2))->assertStatus(202);
        $this->deliver($this->event('ticket.updated', 3, ['title' => 'Edited after closing']))->assertStatus(202);

        $this->assertSame(['completed', 'Edited after closing'], [$this->task()->status, $this->task()->title]);
        $this->assertTrue($this->link()->closed_by_sync, 'still remembered, so a real reassignment can reopen it');

        $this->deliver($this->event('ticket.assigned', 4))->assertStatus(202);
        $this->assertSame('inbox', $this->task()->status);
    }

    public function test_a_completion_the_person_made_is_never_undone_even_after_the_sync_had_completed_it_once(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.closed', 2))->assertStatus(202);   // sync completes it
        $id = $this->task()->id;
        $this->actingAs($this->user)->patchJson("/api/tasks/{$id}", ['status' => 'todo'])->assertOk();        // person reopens it
        $this->actingAs($this->user)->patchJson("/api/tasks/{$id}", ['status' => 'completed'])->assertOk();   // and completes it themselves
        $this->deliver($this->event('ticket.closed', 3))->assertStatus(202);
        $this->assertFalse($this->link()->closed_by_sync);

        $this->deliver($this->event('ticket.assigned', 4))->assertStatus(202);
        $this->assertSame('completed', $this->task()->status);
    }

    public function test_unassigning_a_finished_task_sends_no_notification(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->actingAs($this->user)->patchJson('/api/tasks/'.$this->task()->id, ['status' => 'cancelled'])->assertOk();
        $this->deliver($this->event('ticket.unassigned', 2))->assertStatus(202);

        $this->assertSame(0, InboxNotification::where('kind', 'integration')->count());
        $this->assertSame('unassigned', $this->link()->remote_state);
    }

    public function test_unassigning_works_with_the_longest_account_key_and_ticket_id(): void
    {
        $account = str_repeat('a', 64);
        $ticket = str_repeat('T', 200);
        ['endpoint' => $endpoint, 'secret' => $secret] = app(WebhookEndpointService::class)->create('emc', $this->user, 'Long', requireEventId: true, accountKey: $account);
        $this->deliver($this->event('ticket.assigned', 9007199254740990, ['external_id' => $ticket]), $endpoint, $secret)->assertStatus(202);
        $this->deliver($this->event('ticket.unassigned', 9007199254740991, ['external_id' => $ticket], ['event_id' => 'long-unassign']), $endpoint, $secret)->assertStatus(202);

        $this->assertSame('processed', $this->deliveryStatus('long-unassign'));
        $this->assertSame(1, InboxNotification::where('kind', 'integration')->count());
        $this->assertSame(9007199254740991, IntegrationLink::where('external_id', $ticket)->value('version'));
    }

    public function test_unassigning_keeps_the_task_and_tells_the_person_once(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->task()->forceFill(['notes' => 'Half done'])->save();

        $this->deliver($this->event('ticket.unassigned', 2))->assertStatus(202);
        $this->deliver($this->event('ticket.unassigned', 2, top: ['event_id' => 'evt-again']))->assertStatus(202);   // same version: stale
        $this->deliver($this->event('ticket.updated', 3))->assertStatus(202);
        $this->deliver($this->event('ticket.unassigned', 4))->assertStatus(202);

        $this->assertSame(['inbox', 'Half done'], [$this->task()->status, $this->task()->notes]);
        $this->assertSame('unassigned', $this->link()->remote_state);
        $notes = InboxNotification::where('user_id', $this->user->id)->where('kind', 'integration')->get();
        $this->assertCount(2, $notes, 'one per unassignment, never one per redelivery');
        $this->assertStringContainsString('no longer assigned to you', $notes[0]->title);
    }

    public function test_a_task_the_person_deleted_is_not_recreated_by_an_update_but_is_by_a_new_assignment(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $focus = FocusSession::factory()->create(['user_id' => $this->user->id, 'task_id' => $this->task()->id]);
        $this->actingAs($this->user)->deleteJson('/api/tasks/'.$this->task()->id)->assertOk();
        $this->assertNull($this->link()->fresh()->task_id);
        $this->assertNotNull($focus->fresh(), 'the focus session history stays');

        $this->deliver($this->event('ticket.updated', 2))->assertStatus(202);
        $this->assertSame(0, Task::count());

        $this->deliver($this->event('ticket.assigned', 3))->assertStatus(202);
        $this->assertSame(1, Task::count());
        $this->assertSame($this->task()->id, $this->link()->task_id);
    }

    // ---- isolation between people ---------------------------------------------------------------------------------------------------

    public function test_each_person_gets_their_own_task_for_the_same_ticket_and_cannot_touch_the_others(): void
    {
        $other = User::factory()->create();
        ['endpoint' => $otherEndpoint, 'secret' => $otherSecret] = app(WebhookEndpointService::class)->create('emc', $other, 'EMC', requireEventId: true, accountKey: 'default');
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 1, ['title' => 'Theirs']), $otherEndpoint, $otherSecret)->assertStatus(202);
        $this->deliver($this->event('ticket.closed', 2, ['title' => 'Theirs']), $otherEndpoint, $otherSecret)->assertStatus(202);

        $this->assertSame(['Replace the meeting-room display', 'inbox'], [$this->task()->title, $this->task()->status]);
        $theirs = Task::where('user_id', $other->id)->sole();
        $this->assertSame(['Theirs', 'completed'], [$theirs->title, $theirs->status]);
        $this->assertSame(2, IntegrationLink::count());
        // My secret does not work on their endpoint.
        $this->deliver($this->event('ticket.closed', 9), $otherEndpoint, $this->secret)->assertStatus(401);
    }

    public function test_two_accounts_of_one_person_keep_tickets_with_the_same_id_apart(): void
    {
        ['endpoint' => $second, 'secret' => $secondSecret] = app(WebhookEndpointService::class)->create('emc', $this->user, 'EMC 2', requireEventId: true, accountKey: 'second');
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 1, ['title' => 'Other EMC']), $second, $secondSecret)->assertStatus(202);

        $this->assertSame(['Replace the meeting-room display', 'Other EMC'], Task::orderBy('id')->pluck('title')->all());
        $this->assertSame(['emc:default:T-1042', 'emc:second:T-1042'], Task::orderBy('id')->pluck('source_ref')->all());
    }

    public function test_deleting_the_account_removes_its_links(): void
    {
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);
        $this->user->delete();

        $this->assertSame(0, IntegrationLink::count());
    }

    // ---- security and refusal --------------------------------------------------------------------------------------------------------

    public function test_signature_timestamp_and_signed_event_id_are_enforced_before_anything_is_recorded(): void
    {
        $body = $this->event('ticket.assigned', 1);
        $this->deliver($body, secret: 'whsec_wrong')->assertStatus(401);
        $this->deliver($body, raw: json_encode($body).' ')->assertStatus(202);   // the signed bytes are what counts (re-signed here)
        $tampered = json_encode(array_replace_recursive($body, ['ticket' => ['title' => 'Tampered']]));
        $timestamp = now()->getTimestamp();
        $this->call('POST', '/api/webhooks/'.$this->endpoint->public_id, [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_X_LIFEOS_TIMESTAMP' => (string) $timestamp,
            'HTTP_X_LIFEOS_SIGNATURE' => WebhookVerifier::sign($this->secret, $timestamp, json_encode($body)), 'HTTP_X_LIFEOS_DELIVERY' => $body['event_id']], $tampered)->assertStatus(401);
        $old = now()->subMinutes(6)->getTimestamp();
        $this->call('POST', '/api/webhooks/'.$this->endpoint->public_id, [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_X_LIFEOS_TIMESTAMP' => (string) $old,
            'HTTP_X_LIFEOS_SIGNATURE' => WebhookVerifier::sign($this->secret, $old, json_encode($body)), 'HTTP_X_LIFEOS_DELIVERY' => 'evt-old'], json_encode(array_merge($body, ['event_id' => 'evt-old'])))->assertStatus(401);
        $withoutId = $body;
        unset($withoutId['event_id']);
        $this->deliver($withoutId, delivery: 'evt-no-id')->assertStatus(400);

        $this->assertSame(1, WebhookDelivery::count());
        $this->assertSame('Replace the meeting-room display', $this->task()->title);
    }

    public function test_a_payload_that_breaks_the_contract_fails_at_once_and_applies_nothing(): void
    {
        $cases = [
            'wrong schema' => fn ($e) => array_merge($e, ['schema_version' => 2]),
            'unknown type' => fn ($e) => array_merge($e, ['type' => 'ticket.deleted']),
            'version as string' => fn ($e) => array_replace_recursive($e, ['ticket' => ['version' => '5']]),
            'version zero' => fn ($e) => array_replace_recursive($e, ['ticket' => ['version' => 0]]),
            'no title' => fn ($e) => array_replace_recursive($e, ['ticket' => ['title' => '   ']]),
            'both deadlines' => fn ($e) => array_replace_recursive($e, ['ticket' => ['due_date' => '2026-12-01']]),
            'naive due_at' => fn ($e) => array_replace_recursive($e, ['ticket' => ['due_at' => '2026-12-01 17:00']]),
            'bad external id' => fn ($e) => array_replace_recursive($e, ['ticket' => ['external_id' => 'T 1 <script>']]),
            'ticket not an object' => fn ($e) => array_merge($e, ['ticket' => 'T-1042']),
        ];
        $n = 0;
        foreach ($cases as $name => $make) {
            $body = $make($this->event('ticket.assigned', 1, top: ['event_id' => 'bad-'.(++$n)]));
            $this->deliver($body)->assertStatus(202);
            $delivery = WebhookDelivery::where('delivery_id', 'bad-'.$n)->sole();
            $this->assertSame(['failed', 1], [$delivery->status, $delivery->attempts], $name);
            $this->assertStringStartsWith('PermanentWebhookException:', $delivery->last_error, $name);
            $this->assertStringNotContainsString('script', $delivery->last_error, 'values are never echoed into the error');
        }
        $this->assertSame(0, Task::count());
        $this->assertSame(0, IntegrationLink::count());
    }

    public function test_a_timestamp_too_far_in_the_future_is_refused(): void
    {
        $body = $this->event('ticket.assigned', 1);
        $raw = json_encode($body);
        $future = now()->addMinutes(6)->getTimestamp();
        $this->call('POST', '/api/webhooks/'.$this->endpoint->public_id, [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_X_LIFEOS_TIMESTAMP' => (string) $future,
            'HTTP_X_LIFEOS_SIGNATURE' => WebhookVerifier::sign($this->secret, $future, $raw), 'HTTP_X_LIFEOS_DELIVERY' => $body['event_id']], $raw)->assertStatus(401);

        $this->assertSame(0, WebhookDelivery::count());
    }

    public function test_disabling_the_endpoint_also_stops_deliveries_it_had_already_accepted(): void
    {
        config(['queue.default' => 'database']);
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);   // accepted, waiting in the queue
        $this->endpoint->forceFill(['enabled' => false])->save();

        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();

        $this->assertSame(['failed', 'The endpoint is disabled.'], [$this->deliveryStatus('evt-1-v1'), WebhookDelivery::value('last_error')]);
        $this->assertSame(0, Task::count());
        $this->artisan('lifeos:webhooks:retry', ['--all' => true])->expectsOutputToContain('the endpoint is disabled')->assertSuccessful();
    }

    public function test_misconfigured_endpoints_are_refused_without_applying_anything(): void
    {
        $service = app(WebhookEndpointService::class);
        ['endpoint' => $ownerless, 'secret' => $s1] = $service->create('emc', null, 'No owner', requireEventId: true, accountKey: 'x');
        ['endpoint' => $noAccount, 'secret' => $s2] = $service->create('emc', $this->user, 'No account', requireEventId: true);
        ['endpoint' => $unsigned, 'secret' => $s3] = $service->create('emc', $this->user, 'Unsigned ids', requireEventId: false, accountKey: 'y');
        foreach ([[$ownerless, $s1], [$noAccount, $s2], [$unsigned, $s3]] as $i => [$endpoint, $secret]) {
            $this->deliver($this->event('ticket.assigned', 1, top: ['event_id' => "cfg-{$i}"]), $endpoint, $secret)->assertStatus(202);
            $this->assertSame('failed', $this->deliveryStatus("cfg-{$i}"));
        }
        $this->assertSame(0, Task::count());
    }

    // ---- retries --------------------------------------------------------------------------------------------------------------------

    public function test_a_temporary_database_error_is_retried_with_backoff_and_applied_exactly_once(): void
    {
        config(['queue.default' => 'database', 'integrations.webhooks.backoff_seconds' => [30]]);
        $this->freezeTime();
        $fail = true;
        Task::creating(function () use (&$fail) {
            if ($fail) {
                $fail = false;
                throw new \RuntimeException('could not serialize access due to concurrent update');
            }
        });
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);

        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();
        $this->assertSame('retrying', $this->deliveryStatus('evt-1-v1'));
        $this->assertSame([0, 0], [Task::count(), IntegrationLink::count()], 'the failed run left no task and no link behind');

        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();   // not due yet: the backoff holds it
        $this->assertSame(['retrying', 0], [$this->deliveryStatus('evt-1-v1'), Task::count()]);

        $this->travel(31)->seconds();
        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();
        $this->assertSame('processed', $this->deliveryStatus('evt-1-v1'));
        $this->assertSame([1, 1], [Task::count(), IntegrationLink::count()]);
        $this->assertSame(0, DB::table('jobs')->count());
    }

    public function test_after_the_last_attempt_the_delivery_fails_and_nothing_is_applied(): void
    {
        config(['queue.default' => 'database', 'integrations.webhooks.backoff_seconds' => [1], 'integrations.webhooks.max_attempts' => 2]);
        $this->freezeTime();
        Task::creating(fn () => throw new \RuntimeException('database is down'));
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);

        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();
        $this->travel(2)->seconds();
        $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();

        $delivery = WebhookDelivery::sole();
        $this->assertSame(['failed', 2], [$delivery->status, $delivery->attempts]);
        $this->assertNotNull($delivery->payload, 'kept for lifeos:webhooks:retry');
        $this->assertSame([0, 0, 0], [Task::count(), IntegrationLink::count(), DB::table('jobs')->count()]);
    }

    public function test_events_queued_as_v2_v1_v3_apply_by_version(): void
    {
        config(['queue.default' => 'database']);
        $this->deliver($this->event('ticket.updated', 2, ['title' => 'Newer']))->assertStatus(202);
        $this->deliver($this->event('ticket.assigned', 1, ['title' => 'Older']))->assertStatus(202);
        $this->deliver($this->event('ticket.closed', 3, ['title' => 'Newer']))->assertStatus(202);

        for ($i = 0; $i < 3; $i++) {
            $this->artisan('queue:work', ['--once' => true, '--tries' => 1, '--sleep' => 0])->assertSuccessful();
        }

        $this->assertSame(['Newer', 'completed'], [$this->task()->title, $this->task()->status]);
        $this->assertSame(3, $this->link()->version);
    }

    public function test_a_failed_delivery_can_be_processed_again_once_without_duplicating_the_task(): void
    {
        $fail = true;
        Task::creating(function () use (&$fail) {
            if ($fail) {
                $fail = false;
                throw new \RuntimeException('database went away');
            }
        });
        $this->deliver($this->event('ticket.assigned', 1))->assertStatus(202);   // synchronous queue: one failure is final
        $this->assertSame('failed', $this->deliveryStatus('evt-1-v1'));

        $id = WebhookDelivery::where('delivery_id', 'evt-1-v1')->value('id');
        $this->artisan('lifeos:webhooks:retry', ['ids' => [$id]])->assertSuccessful();
        $this->artisan('lifeos:webhooks:retry', ['ids' => [$id]])->assertSuccessful();

        $this->assertSame('processed', $this->deliveryStatus('evt-1-v1'));
        $this->assertSame(1, Task::count());
    }

    // ---- creating the endpoint ------------------------------------------------------------------------------------------------------

    public function test_the_command_creates_one_signed_endpoint_per_person_and_account_and_shows_the_secret_once(): void
    {
        $person = User::factory()->create(['email' => 'abbas@example.com']);

        $this->artisan('lifeos:emc:create-endpoint', ['email' => 'Abbas@Example.com'])
            ->expectsOutputToContain('EMC endpoint created for abbas@example.com')
            ->expectsOutputToContain('/api/webhooks/')
            ->expectsOutputToContain('Secret: whsec_')
            ->assertSuccessful();
        $endpoint = WebhookEndpoint::where('user_id', $person->id)->sole();
        $this->assertSame(['emc', 'default', true, true], [$endpoint->provider_key, $endpoint->account_key, $endpoint->require_event_id, $endpoint->enabled]);
        $this->assertStringNotContainsString('whsec_', json_encode((array) DB::table('webhook_endpoints')->where('id', $endpoint->id)->first()), 'stored encrypted');

        $this->artisan('lifeos:emc:create-endpoint', ['email' => 'abbas@example.com'])->expectsOutputToContain('already has an EMC endpoint')->assertFailed();
        $this->artisan('lifeos:emc:create-endpoint', ['email' => 'abbas@example.com', '--account' => 'second'])->assertSuccessful();
        $this->artisan('lifeos:emc:create-endpoint', ['email' => 'nobody@example.com'])->assertFailed();
        $this->artisan('lifeos:emc:create-endpoint', ['email' => 'abbas@example.com', '--account' => 'Bad Key!'])->assertFailed();
        $this->assertSame(2, WebhookEndpoint::where('user_id', $person->id)->count());
    }

    public function test_the_command_asks_before_creating_a_live_endpoint_in_production(): void
    {
        User::factory()->create(['email' => 'abbas@example.com']);
        $this->app['env'] = 'production';

        $this->artisan('lifeos:emc:create-endpoint', ['email' => 'abbas@example.com'])
            ->expectsConfirmation('Create a LIVE EMC endpoint for abbas@example.com (account "default")? EMC can then create tasks for this person.', 'no')
            ->assertFailed();
        $this->assertSame(1, WebhookEndpoint::count(), 'only the endpoint from setUp');
    }
}
