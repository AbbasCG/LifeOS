<?php

namespace App\Console\Commands;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Services\TaskScheduler;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;

/**
 * Read-only report of ordinary tasks that have more than one active calendar session. It never modifies or deletes anything: what to do with a
 * duplicate is the user's decision (the suggested policy line is advice only).
 */
class ReportDuplicateTaskSessions extends Command
{
    protected $signature = 'lifeos:schedule:duplicates {--json : Print the report as JSON}';

    protected $description = 'Report tasks (not marked as split) with more than one active calendar session. Read-only: nothing is changed or deleted.';

    public function handle(): int
    {
        $report = $this->report();
        if ($this->option('json')) {
            $this->line(json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

            return self::SUCCESS;
        }
        foreach ($report['tasks'] as $row) {
            $this->line("user {$row['user_id']} task {$row['task_id']} “{$row['title']}”: {$row['sessions']} sessions");
            foreach ($row['events'] as $i => $event) {
                $gap = $i === 0 ? 'first' : "created {$event['created_gap_seconds']}s after the previous one";
                $this->line("    event {$event['id']}  starts {$event['starts_at']}  created {$event['created_at']}  ({$gap})");
            }
            $this->line("    suggestion: {$row['suggestion']}");
        }
        $this->info("Affected tasks: {$report['totals']['affected_tasks']}. Surplus sessions: {$report['totals']['surplus_sessions']}. Nothing was changed.");

        return self::SUCCESS;
    }

    /**
     * @return array{tasks: list<array<string, mixed>>, totals: array{affected_tasks: int, surplus_sessions: int}}
     */
    private function report(): array
    {
        $events = CalendarEvent::query()
            ->whereNotNull('task_id')->whereNull('recurrence')->where('ends_at', '>', now())
            ->whereIn('task_id', Task::query()->select('id')->where('split_sessions', false))
            ->whereIn('task_id', CalendarEvent::query()->select('task_id')->whereNotNull('task_id')->whereNull('recurrence')->where('ends_at', '>', now())->groupBy('task_id')->havingRaw('count(*) > 1'))
            ->orderBy('starts_at')->orderBy('id')->get()->groupBy('task_id');
        $titles = Task::whereIn('id', $events->keys())->pluck('title', 'id');
        $rows = $events->map(fn (Collection $group, int $taskId) => $this->row($taskId, (string) ($titles[$taskId] ?? ''), $group))
            ->sortBy([['user_id', 'asc'], ['task_id', 'asc']])->values()->all();

        return ['tasks' => $rows, 'totals' => ['affected_tasks' => count($rows), 'surplus_sessions' => (int) collect($rows)->sum(fn (array $r) => $r['sessions'] - 1)]];
    }

    /**
     * @param  Collection<int, CalendarEvent>  $group  active sessions of the task, earliest start first
     * @return array<string, mixed>
     */
    private function row(int $taskId, string $title, Collection $group): array
    {
        $byCreation = $group->sortBy([['created_at', 'asc'], ['id', 'asc']])->values();
        $gaps = [];
        foreach ($byCreation as $i => $event) {
            $gaps[$event->id] = $i === 0 ? null : (int) $byCreation[$i - 1]->created_at->diffInSeconds($event->created_at, false);
        }
        $smallest = collect($gaps)->filter(fn ($g) => $g !== null)->min();

        return [
            'user_id' => $group->first()->user_id,
            'task_id' => $taskId,
            'title' => $title,
            'sessions' => $group->count(),
            'events' => $byCreation->map(fn (CalendarEvent $e) => [
                'id' => $e->id,
                'title' => $e->title,
                'starts_at' => TaskScheduler::iso($e->starts_at),
                'ends_at' => TaskScheduler::iso($e->ends_at),
                'created_at' => TaskScheduler::iso($e->created_at),
                'created_gap_seconds' => $gaps[$e->id],
            ])->values()->all(),
            'suggestion' => $smallest !== null && $smallest <= 10
                ? 'Created within seconds of each other: likely a double tap or retry. Keep the earliest session (or the one the user moved), review the rest by hand; never auto-delete.'
                : 'Created apart: possibly a deliberate second booking. Ask the user which one to keep (earliest by default, or the latest if they rescheduled); never auto-delete.',
        ];
    }
}
