<?php

namespace App\Integrations\Emc;

use App\Models\IntegrationLink;
use App\Models\Task;
use App\Models\User;
use App\Models\WebhookEndpoint;
use App\Services\Notifier;
use Carbon\CarbonImmutable;

/**
 * Applies one validated EMC ticket event to the endpoint owner's LifeOS task (rules in docs/EMC_INTEGRATION.md, section 3).
 *
 * Runs inside ProcessWebhookDelivery's transaction (the delivery row is already locked), so the task, the link and the delivery status commit
 * together or not at all. Lock order follows the rest of the app: the user row first (serialises every event of this person, so two events
 * for one ticket can never interleave), then the link, then the task.
 *
 * Ownership of fields: EMC owns title, priority and deadline, and only while the task still has the value EMC sent last time (three-way merge).
 * Everything else on the task belongs to the person and is never written here. Nothing is ever deleted.
 */
class EmcTicketSync
{
    public const SOURCE = 'emc';

    public function __construct(private Notifier $notifier) {}

    /**
     * @return string what happened: created, updated, stale, recorded
     */
    public function apply(WebhookEndpoint $endpoint, EmcTicketEvent $event): string
    {
        $user = User::lockForOrdering((int) $endpoint->user_id);
        $account = (string) $endpoint->account_key;
        $link = IntegrationLink::where('user_id', $user->id)->where('source', self::SOURCE)->where('account_key', $account)
            ->where('external_id', $event->externalId)->lockForUpdate()->first();
        if ($link && $event->version <= $link->version) {
            return 'stale';
        }
        $firstSight = $link === null;
        $link ??= new IntegrationLink(['user_id' => $user->id, 'source' => self::SOURCE, 'account_key' => $account, 'external_id' => $event->externalId]);
        $previous = $firstSight ? null : $this->remote($link);
        $task = $link->task_id ? Task::where('user_id', $user->id)->whereKey($link->task_id)->lockForUpdate()->first() : null;
        $outcome = 'recorded';

        if ($task === null && $event->state() === 'assigned' && ($firstSight || $event->type === 'ticket.assigned')) {
            $task = $this->createTask($user, $account, $event);
            $outcome = 'created';
            $link->closed_by_sync = false;
        } elseif ($task !== null) {
            $outcome = $this->updateTask($task, $link, $previous, $event) ? 'updated' : 'recorded';
        }

        if ($event->state() === 'unassigned' && $task !== null && ($link->remote_state ?? null) !== 'unassigned') {
            $this->notifier->send($user, 'system', "emc:unassigned:{$user->id}:{$account}:{$event->externalId}:{$event->version}",
                ($user->preferences()['language'] ?? 'en') === 'ar' ? 'لم تعد مسندة إليك تذكرة EMC: '.$task->title : 'An EMC ticket is no longer assigned to you: '.$task->title,
                ['kind' => 'integration', 'link' => '/tasks']);
        }

        $link->fill([
            'webhook_endpoint_id' => $endpoint->id, 'task_id' => $task?->id, 'version' => $event->version, 'last_event_id' => $event->eventId,
            'remote_state' => $event->state(), 'remote_title' => $event->title, 'remote_priority' => $event->priority, 'remote_due_at' => $event->dueAt,
            'remote_due_all_day' => $event->dueAllDay, 'remote_url' => $event->url, 'remote_assignee' => $event->assignee, 'synced_at' => now(),
        ])->save();

        return $outcome;
    }

    private function createTask(User $user, string $account, EmcTicketEvent $event): Task
    {
        $ref = self::sourceRef($account, $event->externalId);
        // A task with this reference may survive a link that was lost (e.g. restored from a backup): reuse it instead of a duplicate.
        $existing = Task::where('user_id', $user->id)->where('source_ref', $ref)->lockForUpdate()->first();
        if ($existing) {
            return $existing;
        }

        return Task::create([
            'user_id' => $user->id, 'title' => $event->title, 'status' => 'inbox', 'priority' => $event->priority,
            'due_at' => $event->dueAt, 'due_all_day' => $event->dueAllDay, 'source_ref' => $ref, 'tags' => ['emc'],
            'description' => 'EMC ticket '.$event->externalId.($event->url ? ': '.$event->url : ''),
        ]);
    }

    /**
     * Three-way merge of the fields EMC owns, then the closed / reopened state. Saved quietly: an EMC deadline change is not a postponement by
     * the person (Task's updating hook would count it) and touches nothing else.
     *
     * @param  array{title: string, priority: string, due_at: ?CarbonImmutable, due_all_day: bool}|null  $previous  what EMC sent last time
     */
    private function updateTask(Task $task, IntegrationLink $link, ?array $previous, EmcTicketEvent $event): bool
    {
        $changes = [];
        $untouched = fn (string $field, mixed $theirs): bool => $previous !== null && $theirs === $previous[$field];
        if ($untouched('title', $task->title) && $task->title !== $event->title) {
            $changes['title'] = $event->title;
        }
        if ($untouched('priority', $task->priority) && $task->priority !== $event->priority) {
            $changes['priority'] = $event->priority;
        }
        $taskDue = ['at' => $task->due_at?->getTimestamp(), 'all_day' => (bool) $task->due_all_day];
        $lastDue = $previous === null ? null : ['at' => $previous['due_at']?->getTimestamp(), 'all_day' => $previous['due_all_day']];
        $newDue = ['at' => $event->dueAt?->getTimestamp(), 'all_day' => $event->dueAllDay];
        if ($lastDue !== null && $taskDue === $lastDue && $taskDue !== $newDue) {
            $changes['due_at'] = $event->dueAt;
            $changes['due_all_day'] = $event->dueAllDay;
        }

        $open = ! in_array($task->status, ['completed', 'cancelled'], true);
        if ($event->state() === 'closed' && $open) {
            $changes['status'] = 'completed';
            $changes['completed_at'] = now();
            $link->closed_by_sync = true;
        } elseif ($event->state() === 'assigned' && $link->closed_by_sync && $task->status === 'completed') {
            // Only a completion LifeOS made for a closed ticket is undone; a task the person completed themselves stays completed.
            $changes['status'] = 'todo';
            $changes['completed_at'] = null;
            $link->closed_by_sync = false;
        } elseif ($event->state() === 'assigned') {
            $link->closed_by_sync = false;
        }

        if ($changes === []) {
            return false;
        }
        $task->forceFill($changes)->saveQuietly();

        return true;
    }

    /**
     * @return array{title: string, priority: string, due_at: ?CarbonImmutable, due_all_day: bool}
     */
    private function remote(IntegrationLink $link): array
    {
        return ['title' => $link->remote_title, 'priority' => $link->remote_priority, 'due_at' => $link->remote_due_at, 'due_all_day' => (bool) $link->remote_due_all_day];
    }

    public static function sourceRef(string $account, string $externalId): string
    {
        return self::SOURCE.':'.$account.':'.$externalId;
    }
}
