<?php

namespace App\Http\Controllers;

use App\Http\Resources\WorkspaceResource;
use App\Models\CalendarEvent;
use App\Models\CalendarEventException;
use App\Models\User;
use App\Services\CalendarService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class CalendarController extends Controller
{
    public function __construct(private CalendarService $calendar) {}

    /**
     * Expanded occurrences (single, recurring and external) for a window of at most 62 days.
     */
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate(['from' => 'required|date', 'to' => 'required|date|after:from']);
        $from = CarbonImmutable::parse($data['from'])->utc();
        $to = CarbonImmutable::parse($data['to'])->utc();
        if ($from->diffInDays($to) > 62) {
            throw ValidationException::withMessages(['to' => ['The calendar window may span at most 62 days.']]);
        }

        return response()->json(['data' => $this->calendar->occurrences($request->user(), $from, $to)->map(fn (array $o) => CalendarService::present($o))->values()]);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validated($request, true);
        $event = new CalendarEvent;
        $this->fill($event, $data, $request->user());
        $this->guardConflicts($request, $event, null);
        $event->save();

        return (new WorkspaceResource($event->fresh()))->response()->setStatusCode(201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $event = CalendarEvent::where('user_id', $request->user()->id)->findOrFail($id);
        $data = $this->validated($request, false);
        if (($data['scope'] ?? 'series') === 'occurrence') {
            return $this->updateOccurrence($request, $event, $data);
        }

        return DB::transaction(function () use ($request, $event, $data) {
            $before = ['start' => $event->starts_at, 'rule' => $event->recurrence, 'tz' => $event->timezone];
            $this->fill($event, $data, $request->user());
            $timeChanged = ! $event->starts_at->equalTo($before['start']) || $event->isDirty('ends_at');
            if ($timeChanged && $event->getOriginal('kind') === 'fixed' && $event->kind === 'fixed' && ! $request->boolean('confirm_fixed')) {
                throw ValidationException::withMessages(['fixed' => ['This is a fixed commitment. Confirm before changing its time.']]);
            }
            if ($timeChanged || $event->isDirty(['recurrence', 'kind'])) {
                $this->guardConflicts($request, $event, $event->id);
            }
            $event->save();
            if ($event->isRecurring()) {
                $this->remapExceptions($event, $before);
            } else {
                $event->exceptions()->delete();
            }

            return (new WorkspaceResource($event->fresh()))->response();
        });
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $event = CalendarEvent::where('user_id', $request->user()->id)->findOrFail($id);
        $data = $request->validate(['scope' => 'sometimes|in:series,occurrence', 'occurrence_start' => 'required_if:scope,occurrence|date']);
        if (($data['scope'] ?? 'series') === 'occurrence') {
            $original = $this->originalStart($event, $data['occurrence_start']);
            CalendarEventException::updateOrCreate(['calendar_event_id' => $event->id, 'original_start' => $original], ['cancelled' => true]);

            return response()->json(['message' => 'Occurrence deleted.']);
        }
        $event->delete();

        return response()->json(['message' => 'Deleted.']);
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function updateOccurrence(Request $request, CalendarEvent $event, array $data): JsonResponse
    {
        if (! $event->isRecurring()) {
            throw ValidationException::withMessages(['scope' => ['Only recurring events have individual occurrences.']]);
        }
        $original = $this->originalStart($event, $data['occurrence_start'] ?? null);
        $existing = CalendarEventException::where('calendar_event_id', $event->id)->where('original_start', $original)->first();
        $duration = (int) $event->starts_at->diffInSeconds($event->ends_at);
        $currentStart = $existing?->starts_at ?? $original;
        $currentEnd = $existing?->ends_at ?? $original->addSeconds($duration);
        $start = isset($data['starts_at']) ? CarbonImmutable::parse($data['starts_at'])->utc() : $currentStart;
        $end = isset($data['ends_at']) ? CarbonImmutable::parse($data['ends_at'])->utc() : $currentEnd;
        if ($end <= $start) {
            throw ValidationException::withMessages(['ends_at' => ['End must follow start.']]);
        }
        $kind = $data['kind'] ?? $existing?->kind ?? $event->kind;
        $timeChanged = ! $start->equalTo($currentStart) || ! $end->equalTo($currentEnd);
        if ($timeChanged && $kind === 'fixed' && ($existing?->kind ?? $event->kind) === 'fixed' && ! $request->boolean('confirm_fixed')) {
            throw ValidationException::withMessages(['fixed' => ['This is a fixed commitment. Confirm before changing its time.']]);
        }
        if ($timeChanged) {
            $this->rejectConflict($this->calendar->conflicts($request->user(), $start, $end, $event->id, $original)->first());
        }
        $exception = CalendarEventException::updateOrCreate(['calendar_event_id' => $event->id, 'original_start' => $original], [
            'cancelled' => false,
            'title' => array_key_exists('title', $data) && $data['title'] !== $event->title ? $data['title'] : $existing?->title,
            'description' => array_key_exists('description', $data) ? $data['description'] : $existing?->description,
            'kind' => $kind !== $event->kind ? $kind : null,
            'starts_at' => $start->equalTo($original) ? null : $start,
            'ends_at' => $end->equalTo($original->addSeconds($duration)) ? null : $end,
        ]);
        $occurrence = collect($this->calendar->expand($event, $start->subSecond(), $end->addSecond()))->first(fn (array $o) => $o['occurrence_start']?->equalTo($original));

        return response()->json(['data' => $occurrence ? CalendarService::present($occurrence) : null, 'exception_id' => $exception->id]);
    }

    private function originalStart(CalendarEvent $event, ?string $value): CarbonImmutable
    {
        if (! $value || ! $event->isRecurring()) {
            throw ValidationException::withMessages(['occurrence_start' => ['Choose an occurrence of a recurring event.']]);
        }
        $original = CarbonImmutable::parse($value)->utc();
        if (! $this->calendar->isOccurrence($event, $original)) {
            throw ValidationException::withMessages(['occurrence_start' => ['That date is not an occurrence of this series.']]);
        }

        return $original;
    }

    /**
     * Single events must not overlap anything. Series report up to five upcoming clashes and may be saved
     * anyway with ignore_conflicts=true (overlaps are then highlighted in the calendar).
     */
    private function guardConflicts(Request $request, CalendarEvent $event, ?int $ignoreEventId): void
    {
        if (! $event->isRecurring()) {
            $this->rejectConflict($this->calendar->conflicts($request->user(), $event->starts_at, $event->ends_at, $ignoreEventId)->first());

            return;
        }
        if ($request->boolean('ignore_conflicts')) {
            return;
        }
        $clashes = $this->calendar->seriesConflicts($request->user(), $event);
        if ($clashes) {
            $lines = collect($clashes)->map(fn (array $c) => "{$c['date']}: “{$c['title']}”")->implode('; ');
            throw ValidationException::withMessages(['recurrence_conflicts' => ["This series overlaps existing events: {$lines}. Save anyway or choose another time."]]);
        }
    }

    /**
     * @param  array<string, mixed>|null  $conflict
     */
    private function rejectConflict(?array $conflict): void
    {
        if ($conflict) {
            throw ValidationException::withMessages(['starts_at' => ["This time conflicts with “{$conflict['title']}” ({$conflict['starts_at']->toIso8601String()} – {$conflict['ends_at']->toIso8601String()}). Choose another time."]]);
        }
    }

    /**
     * Keep exceptions attached after a series moves: shift them by the same offset and drop any that no longer
     * correspond to an occurrence (e.g. after the rule changed).
     *
     * @param  array{start: CarbonImmutable, rule: mixed, tz: mixed}  $before
     */
    private function remapExceptions(CalendarEvent $event, array $before): void
    {
        $shift = (int) $before['start']->diffInSeconds($event->starts_at, false);
        foreach ($event->exceptions()->get() as $exception) {
            $moved = $exception->original_start->addSeconds($shift);
            if ($shift !== 0) {
                if (CalendarEventException::where('calendar_event_id', $event->id)->where('original_start', $moved)->where('id', '!=', $exception->id)->exists()) {
                    $exception->delete();

                    continue;
                }
                $exception->original_start = $moved;
                $exception->save();
            }
            if (! $this->calendar->isOccurrence($event, $exception->original_start)) {
                $exception->delete();
            }
        }
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function fill(CalendarEvent $event, array $data, User $user): void
    {
        $fields = array_intersect_key($data, array_flip(['title', 'description', 'kind', 'task_id', 'remind_minutes']));
        $event->fill($fields);
        $event->user_id = $user->id;
        $start = CarbonImmutable::parse($data['starts_at'] ?? $event->starts_at)->utc();
        $end = CarbonImmutable::parse($data['ends_at'] ?? $event->ends_at)->utc();
        if ($end <= $start) {
            throw ValidationException::withMessages(['ends_at' => ['End must follow start.']]);
        }
        $event->starts_at = $start;
        $event->ends_at = $end;
        $event->kind ??= 'fixed';
        if (array_key_exists('recurrence', $data)) {
            $rule = $data['recurrence'];
            $event->recurrence = $rule ? array_filter([
                'freq' => $rule['freq'],
                'interval' => (int) ($rule['interval'] ?? 1),
                'by_weekday' => $rule['freq'] === 'weekly' ? array_values(array_unique(array_map('intval', $rule['by_weekday'] ?? [CarbonImmutable::parse($start)->setTimezone($data['timezone'] ?? $event->timezone ?? $user->timezone())->dayOfWeek]))) : null,
                'count' => isset($rule['count']) ? (int) $rule['count'] : null,
                'until' => $rule['until'] ?? null,
            ], fn ($v) => $v !== null) : null;
        }
        if ($event->isRecurring()) {
            $event->timezone = $data['timezone'] ?? $event->timezone ?? $user->timezone();
            if (! empty($event->recurrence['until']) && $event->recurrence['until'] < $start->setTimezone($event->timezone)->toDateString()) {
                throw ValidationException::withMessages(['recurrence.until' => ['The series must end on or after its first occurrence.']]);
            }
            $event->recurrence_until = $this->calendar->lastOccurrenceDate($event);
        } else {
            $event->timezone = $data['timezone'] ?? $event->timezone;
            $event->recurrence_until = null;
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return $request->validate([
            'title' => [$required, 'string', 'max:200'],
            'description' => ['nullable', 'string', 'max:10000'],
            'starts_at' => [$required, 'date'],
            'ends_at' => [$required, 'date'],
            'kind' => ['sometimes', Rule::in(['fixed', 'flexible'])],
            'task_id' => ['nullable', Rule::exists('tasks', 'id')->where('user_id', $request->user()->id)],
            'timezone' => ['nullable', 'timezone'],
            'remind_minutes' => ['nullable', 'integer', Rule::in([0, 5, 10, 15, 30, 60, 120, 1440])],
            'recurrence' => ['nullable', 'array:freq,interval,by_weekday,count,until'],
            'recurrence.freq' => ['required_with:recurrence', Rule::in(CalendarService::FREQUENCIES)],
            'recurrence.interval' => ['sometimes', 'integer', 'min:1', 'max:365'],
            'recurrence.by_weekday' => ['sometimes', 'array', 'min:1', 'max:7'],
            'recurrence.by_weekday.*' => ['integer', 'distinct', 'min:0', 'max:6'],
            'recurrence.count' => ['nullable', 'integer', 'min:1', 'max:1000', 'prohibits:recurrence.until'],
            'recurrence.until' => ['nullable', 'date_format:Y-m-d'],
            'scope' => ['sometimes', Rule::in(['series', 'occurrence'])],
            'occurrence_start' => ['required_if:scope,occurrence', 'date'],
            'confirm_fixed' => ['sometimes', 'boolean'],
            'ignore_conflicts' => ['sometimes', 'boolean'],
        ]);
    }
}
