<?php

namespace App\Services;

use App\Models\CalendarEvent;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class PlanningService
{
    public function generate(User $user, string $date, int $days): ScheduleProposal
    {
        $prefs = UserSetting::where('user_id', $user->id)->first()?->preferences ?? [];
        $tz = $prefs['timezone'] ?? 'UTC';
        $first = CarbonImmutable::parse($date, $tz)->startOfDay();
        $events = CalendarEvent::where('user_id', $user->id)->where('ends_at', '>', $first->utc())->where('starts_at', '<', $first->addDays($days)->utc())->get();
        $tasks = Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->get()->sortBy(fn ($t) => [array_search($t->priority, ['urgent', 'high', 'medium', 'low']), $t->due_at?->timestamp ?? PHP_INT_MAX]);
        $items = [];
        $warnings = [];
        $occupied = $events->map(fn ($e) => [$e->starts_at, $e->ends_at])->all();
        foreach ($tasks as $task) {
            $already = CalendarEvent::where('user_id', $user->id)->where('task_id', $task->id)->where('ends_at', '>', now())->exists();
            if ($already) {
                continue;
            }
            $remaining = $task->estimated_minutes;
            $taskItems = [];
            $taskOccupied = $occupied;
            for ($day = 0; $day < $days && $remaining > 0; $day++) {
                $local = $first->addDays($day);
                if (! in_array($local->dayOfWeek, $prefs['work_days'] ?? [1, 2, 3, 4, 5])) {
                    continue;
                }
                $cursor = $local->setTimeFromTimeString($prefs['work_start'] ?? '09:00')->utc();
                $end = $local->setTimeFromTimeString($prefs['work_end'] ?? '17:00')->utc();
                if ($cursor->isPast()) {
                    $cursor = CarbonImmutable::now()->addMinutes(5)->startOfMinute();
                }
                while ($cursor < $end && $remaining > 0) {
                    $minutes = min(60, $remaining);
                    $finish = $cursor->addMinutes($minutes);
                    if ($finish > $end || ($task->due_at && $finish > $task->due_at)) {
                        break;
                    }
                    $conflict = false;
                    foreach ($taskOccupied as [$busyStart,$busyEnd]) {
                        if ($cursor < $busyEnd && $finish > $busyStart) {
                            $cursor = $busyEnd->addMinutes($prefs['break_minutes'] ?? 10);
                            $conflict = true;
                            break;
                        }
                    }
                    if ($conflict) {
                        continue;
                    }
                    $taskItems[] = ['task_id' => $task->id, 'task_version' => $task->updated_at->toISOString(), 'title' => $task->title, 'starts_at' => $cursor->toIso8601String(), 'ends_at' => $finish->toIso8601String(), 'reason' => $task->priority.' priority; fits availability and deadline.'];
                    $taskOccupied[] = [$cursor, $finish->addMinutes($prefs['break_minutes'] ?? 10)];
                    $remaining -= $minutes;
                    $cursor = $finish->addMinutes($prefs['break_minutes'] ?? 10);
                }
            }
            if ($remaining > 0) {
                $warnings[] = ['task_id' => $task->id, 'title' => $task->title, 'reason' => 'Insufficient time before the deadline. No partial task was scheduled.'];
            } else {
                $items = array_merge($items, $taskItems);
                $occupied = $taskOccupied;
            }
        }

        return ScheduleProposal::create(['user_id' => $user->id, 'items' => $items, 'warnings' => $warnings])->fresh();
    }

    public function accept(User $user, int $id): ScheduleProposal
    {
        return DB::transaction(function () use ($user, $id) {
            User::whereKey($user->id)->lockForUpdate()->firstOrFail();
            $proposal = ScheduleProposal::where('user_id', $user->id)->lockForUpdate()->findOrFail($id);
            if ($proposal->status !== 'pending') {
                throw ValidationException::withMessages(['proposal' => ['This proposal has already been resolved.']]);
            }
            $prefs = UserSetting::where('user_id', $user->id)->first()?->preferences ?? [];
            $validated = [];
            $occupied = CalendarEvent::where('user_id', $user->id)->get();
            foreach ($proposal->items as $item) {
                $task = Task::where('user_id', $user->id)->find($item['task_id']);
                if ($task && !isset($validated[$task->id])) {
                    $total = collect($proposal->items)->where('task_id', $task->id)->sum(fn ($part) => CarbonImmutable::parse($part['starts_at'])->diffInMinutes(CarbonImmutable::parse($part['ends_at'])));
                    if (abs($total - $task->estimated_minutes) > 0.01 || (isset($item['task_version']) && $item['task_version'] !== $task->updated_at->toISOString())) {
                        throw ValidationException::withMessages(['proposal' => ['A task changed after this proposal. Generate a fresh plan.']]);
                    }
                    $validated[$task->id] = true;
                }
                $start = CarbonImmutable::parse($item['starts_at']);
                $end = CarbonImmutable::parse($item['ends_at']);
                $localStart = $start->setTimezone($prefs['timezone'] ?? 'UTC');
                $localEnd = $end->setTimezone($prefs['timezone'] ?? 'UTC');
                if (!in_array($localStart->dayOfWeek, $prefs['work_days'] ?? [1,2,3,4,5]) || $localStart->toDateString() !== $localEnd->toDateString() || $localStart->format('H:i') < ($prefs['work_start'] ?? '09:00') || $localEnd->format('H:i') > ($prefs['work_end'] ?? '17:00') || $end <= $start) {
                    throw ValidationException::withMessages(['proposal' => ['Availability changed. Generate a fresh proposal.']]);
                }
                if (! $task || in_array($task->status, ['completed', 'cancelled']) || $start->isPast() || ($task->due_at && $end > $task->due_at)) {
                    throw ValidationException::withMessages(['proposal' => ['Tasks or dates changed. Generate a fresh proposal.']]);
                }
                foreach ($occupied as $event) {
                    if ($start < $event->ends_at && $end > $event->starts_at) {
                        throw ValidationException::withMessages(['proposal' => ['The calendar changed. Generate a new plan to avoid conflicts.']]);
                    }
                }
                $event = CalendarEvent::create(['user_id' => $user->id, 'task_id' => $task->id, 'task_version' => $task->updated_at->toISOString(), 'title' => $task->title, 'starts_at' => $start->utc(), 'ends_at' => $end->utc(), 'kind' => 'flexible']);
                $occupied->push($event);
                $task->update(['scheduled_start' => $task->scheduled_start ? min($task->scheduled_start, $start) : $start, 'scheduled_end' => $end]);
            }
            $proposal->update(['status' => 'accepted']);

            return $proposal;
        });
    }
}



