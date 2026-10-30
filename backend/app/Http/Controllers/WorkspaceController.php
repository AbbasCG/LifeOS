<?php

namespace App\Http\Controllers;

use App\Http\Requests\ResourceRequest;
use App\Http\Resources\WorkspaceResource;
use App\Models\AssistantProposal;
use App\Models\AutomationRule;
use App\Models\AutomationRun;
use App\Models\CalendarEvent;
use App\Models\CalendarEventException;
use App\Models\Category;
use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\Project;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Policies\OwnedResourcePolicy;
use App\Services\AuditLogger;
use App\Services\HabitStreaks;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class WorkspaceController extends Controller
{
    public const DASHBOARD_WIDGETS = ['today', 'intelligence', 'suggestions', 'stats', 'progress', 'next_moves', 'agenda', 'focus_time', 'checkin', 'deadlines', 'habits', 'goals', 'actions', 'focus', 'weekly', 'review'];

    /** Sections of the top of Today (V22; "focus" since V24). "now" can be moved but never hidden. */
    public const TODAY_SECTIONS = ['now', 'checkin', 'strip', 'top3', 'progress', 'focus', 'habits', 'copilot', 'suggestions'];

    public const MODELS = ['tasks' => Task::class, 'projects' => Project::class, 'categories' => Category::class, 'events' => CalendarEvent::class, 'goals' => Goal::class, 'habits' => Habit::class];

    private function model(string $resource): string
    {
        abort_unless(isset(self::MODELS[$resource]), 404);

        return self::MODELS[$resource];
    }

    private function owned(Request $request, string $resource, int $id): Model
    {
        $record = $this->model($resource)::where('user_id', $request->user()->id)->findOrFail($id);
        abort_unless((new OwnedResourcePolicy)->view($request->user(), $record), 403);

        return $record;
    }

    public function index(Request $request, string $resource): mixed
    {
        $query = $this->model($resource)::where('user_id', $request->user()->id);
        if ($request->filled('search')) {
            $term = '%'.str_replace(['!', '%', '_'], ['!!', '!%', '!_'], mb_strtolower(mb_substr($request->string('search'), 0, 200))).'%';
            $query->where(fn ($q) => $q->whereRaw("LOWER(title) LIKE ? ESCAPE '!'", [$term])->orWhereRaw("LOWER(COALESCE(description, '')) LIKE ? ESCAPE '!'", [$term]));
        }
        if ($resource === 'tasks') {
            if ($request->filled('status')) {
                $query->where('status', $request->string('status'));
            }
            if ($request->filled('priority')) {
                $query->where('priority', $request->string('priority'));
            }
            if ($request->filled('project_id')) {
                $query->where('project_id', $request->integer('project_id'));
            }
            if ($request->filled('goal_id')) {
                $query->where('goal_id', $request->integer('goal_id'));
            }
            if ($request->filled('category_id')) {
                $query->where('category_id', $request->integer('category_id'));
            }
            if ($request->filled('due')) {
                $tz = $request->user()->timezone();
                $dayStart = CarbonImmutable::now($tz)->startOfDay();
                $open = fn ($q) => $q->whereNotIn('status', ['completed', 'cancelled']);
                match ($request->string('due')->toString()) {
                    'overdue' => $open($query)->where('due_at', '<', now()),
                    'today' => $query->whereBetween('due_at', [$dayStart->utc(), $dayStart->addDay()->utc()]),
                    'week' => $open($query)->whereBetween('due_at', [$dayStart->utc(), $dayStart->addDays(7)->utc()]),
                    'none' => $query->whereNull('due_at'),
                    'open' => $open($query),
                    default => null,
                };
            }
        }
        if ($resource === 'events') {
            $request->validate(['from' => 'sometimes|date', 'to' => 'sometimes|date|after:from']);
            if ($request->filled('from')) {
                $query->where('ends_at', '>', $request->date('from'));
            } if ($request->filled('to')) {
                $query->where('starts_at', '<', $request->date('to'));
            }
        }
        $sort = $request->input('sort');
        match (true) {
            $sort === 'title' => $query->orderBy('title'),
            $sort === 'updated_at' => $query->orderByDesc('updated_at'),
            $sort === 'due_at' && in_array($resource, ['tasks', 'projects', 'goals']) => $query->orderByRaw('due_at IS NULL, due_at ASC'),
            $sort === 'priority' && $resource === 'tasks' => $query->orderByRaw("CASE WHEN status IN ('completed', 'cancelled') THEN 1 ELSE 0 END")->orderByRaw("CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END")->orderByRaw('due_at IS NULL, due_at ASC'),
            $resource === 'events' => $query->orderBy('starts_at'),
            default => $query->orderByDesc('created_at'),
        };
        $page = $query->orderByDesc('id')->paginate(min(100, max(1, $request->integer('per_page', 50))));
        if ($resource === 'habits') {
            $ids = $page->pluck('id');
            $today = CarbonImmutable::now($request->user()->timezone())->startOfDay();
            $entries = HabitEntry::whereIn('habit_id', $ids)->where('date', '>=', $today->subDays(400)->toDateString())->get()->groupBy('habit_id');
            $streaks = app(HabitStreaks::class);
            $page->getCollection()->each(function ($habit) use ($entries, $streaks, $today) {
                $habitEntries = $entries->get($habit->id, collect());
                $habit->setAttribute('entries', $habitEntries->map(fn ($entry) => ['date' => substr((string) $entry->date, 0, 10)])->values());
                $habit->forceFill($streaks->calculate($habitEntries->map(fn ($entry) => substr((string) $entry->date, 0, 10)), $habit->recurrence, $today));
            });
        }

        return WorkspaceResource::collection($page);
    }

    public function show(Request $request, string $resource, int $id): WorkspaceResource
    {
        return new WorkspaceResource($this->owned($request, $resource, $id));
    }

    public function store(ResourceRequest $request, string $resource): JsonResponse
    {
        // A task queued offline may be sent twice (lost response, retry): the device's id returns the first one.
        $replay = fn () => $resource === 'tasks' && $request->filled('client_id')
            ? Task::where('user_id', $request->user()->id)->where('client_id', $request->input('client_id'))->first()
            : null;
        if ($existing = $replay()) {
            return (new WorkspaceResource($existing))->response()->setStatusCode(200);
        }
        try {
            return $this->save($request, $resource, null)->response()->setStatusCode(201);
        } catch (UniqueConstraintViolationException $e) {
            $existing = $replay();
            if (! $existing) {
                throw $e;
            }

            return (new WorkspaceResource($existing))->response()->setStatusCode(200);
        }
    }

    public function update(ResourceRequest $request, string $resource, int $id): WorkspaceResource
    {
        return $this->save($request, $resource, $id);
    }

    private function save(ResourceRequest $request, string $resource, ?int $id): WorkspaceResource
    {
        return DB::transaction(function () use ($request, $resource, $id) {
            User::whereKey($request->user()->id)->lockForUpdate()->firstOrFail();
            $model = $this->model($resource);
            $record = $id ? $this->owned($request, $resource, $id) : new $model;
            $data = $request->validated();
            $wasComplete = $record->status === 'completed';
            if ($resource === 'tasks' && isset($data['status'])) {
                $data['completed_at'] = $data['status'] === 'completed' ? ($record->completed_at ?? now()) : null;
            }
            $record->fill($data);
            $record->user_id = $request->user()->id;
            $record->save();
            if ($resource === 'tasks' && ! $wasComplete && $record->status === 'completed') {
                $record->createNextOccurrence();
            }

            return new WorkspaceResource($record->fresh());
        });
    }

    public function destroy(Request $request, string $resource, int $id): JsonResponse
    {
        $this->owned($request, $resource, $id)->delete();

        return response()->json(['message' => 'Deleted.']);
    }

    public function habitEntry(Request $request, int $id): JsonResponse
    {
        $habit = $this->owned($request, 'habits', $id);
        // "Today" is the user's day in their own timezone; the app's default timezone (UTC) would reject a habit logged
        // early in the local day for anyone ahead of UTC.
        $today = CarbonImmutable::now($request->user()->timezone())->toDateString();
        $data = $request->validate(['date' => 'required|date_format:Y-m-d|before_or_equal:'.$today, 'completed' => 'required|boolean']);
        if ($data['completed']) {
            HabitEntry::firstOrCreate(['habit_id' => $habit->id, 'date' => $data['date']]);
        } else {
            HabitEntry::where('habit_id', $habit->id)->where('date', $data['date'])->delete();
        }

        return response()->json(['message' => 'Saved.']);
    }

    public function settings(Request $request): JsonResponse
    {
        return response()->json(UserSetting::firstOrCreate(['user_id' => $request->user()->id], ['preferences' => ['language' => 'en', 'theme' => 'system', 'timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'break_minutes' => 10, 'work_days' => [1, 2, 3, 4, 5]]])->preferences);
    }

    /**
     * Validation for the per-device top of Today. Written per device because `distinct` with a wildcard would compare
     * the phone's sections with the desktop's.
     *
     * @return array<string, string>
     */
    private static function todayLayoutRules(): array
    {
        $rules = ['today_layout' => 'sometimes|array:phone,desktop'];
        foreach (['phone', 'desktop'] as $device) {
            $rules += [
                "today_layout.{$device}" => 'array:order,hidden',
                "today_layout.{$device}.order" => 'sometimes|array|max:'.count(self::TODAY_SECTIONS),
                "today_layout.{$device}.order.*" => 'distinct|in:'.implode(',', self::TODAY_SECTIONS),
                "today_layout.{$device}.hidden" => 'sometimes|array|max:'.(count(self::TODAY_SECTIONS) - 1),
                "today_layout.{$device}.hidden.*" => 'distinct|in:'.implode(',', array_diff(self::TODAY_SECTIONS, ['now'])),
            ];
        }

        return $rules;
    }

    public function saveSettings(Request $request): JsonResponse
    {
        $data = $request->validate(['language' => 'sometimes|in:en,ar', 'theme' => 'sometimes|in:light,dark,system', 'timezone' => 'sometimes|timezone', 'work_start' => 'sometimes|date_format:H:i', 'work_end' => 'sometimes|date_format:H:i', 'break_minutes' => 'sometimes|integer|min:0|max:60', 'work_days' => 'sometimes|array|min:1|max:7', 'work_days.*' => 'integer|min:0|max:6', 'week_start' => 'sometimes|integer|min:0|max:6', 'time_format' => 'sometimes|in:12,24', 'notifications' => 'sometimes|boolean', 'quiet_start' => 'nullable|date_format:H:i', 'quiet_end' => 'nullable|date_format:H:i', 'widgets' => 'sometimes|array|max:10', 'widgets.*' => 'in:tasks,timeline,focus,insights', 'dashboard' => 'sometimes|array:order,hidden', 'dashboard.order' => 'sometimes|array|max:'.count(self::DASHBOARD_WIDGETS), 'dashboard.order.*' => 'distinct|in:'.implode(',', self::DASHBOARD_WIDGETS), 'dashboard.hidden' => 'sometimes|array|max:'.count(self::DASHBOARD_WIDGETS), 'dashboard.hidden.*' => 'distinct|in:'.implode(',', self::DASHBOARD_WIDGETS), 'focus_block_minutes' => 'sometimes|integer|min:15|max:180', 'daily_focus_limit' => 'nullable|integer|min:30|max:900', 'daily_focus_goal' => 'nullable|integer|min:10|max:720', 'focus_start' => 'nullable|date_format:H:i', 'focus_end' => 'nullable|date_format:H:i', 'assistant_external' => 'sometimes|boolean', 'ai_connected_data' => 'sometimes|boolean', 'voice_input' => 'sometimes|boolean', 'checkins_enabled' => 'sometimes|boolean', 'buffer_minutes' => 'sometimes|integer|min:0|max:60', 'study_start' => 'nullable|date_format:H:i', 'study_end' => 'nullable|date_format:H:i|required_with:study_start', 'personal_start' => 'nullable|date_format:H:i', 'personal_end' => 'nullable|date_format:H:i|required_with:personal_start', 'study_daily_limit' => 'nullable|integer|min:15|max:900', 'personal_daily_limit' => 'nullable|integer|min:15|max:900', 'event_remind_minutes' => 'sometimes|integer|min:0|max:1440', 'notification_channels' => 'sometimes|array:reminders,deadlines,calendar,focus,planning,review,system', 'notification_channels.*' => 'array:enabled,push', 'notification_channels.*.enabled' => 'sometimes|boolean', 'notification_channels.*.push' => 'sometimes|boolean'] + self::todayLayoutRules());
        $record = UserSetting::firstOrCreate(['user_id' => $request->user()->id], ['preferences' => []]);
        $prefs = array_replace($record->preferences, $data);
        if (($prefs['work_end'] ?? '17:00') <= ($prefs['work_start'] ?? '09:00')) {
            throw ValidationException::withMessages(['work_end' => ['Work end must follow work start.']]);
        }
        $record->update(['preferences' => $prefs]);

        return response()->json($prefs);
    }

    public function overview(Request $request): JsonResponse
    {
        $uid = $request->user()->id;
        $tz = UserSetting::where('user_id', $uid)->first()?->preferences['timezone'] ?? 'UTC';
        $today = CarbonImmutable::now($tz)->startOfDay();
        $start = $today->subDays(6)->utc();
        $tasks = Task::where('user_id', $uid);
        $completed = (clone $tasks)->where('status', 'completed')->count();
        $total = (clone $tasks)->count();
        $sessions = FocusSession::where('user_id', $uid)->where('status', 'completed')->whereIn('kind', ['focus', 'manual'])->where('completed_at', '>=', $start)->get();
        $days = collect(range(0, 6))->map(function ($i) use ($today, $sessions) {
            $date = $today->subDays(6 - $i)->toDateString();

            return ['date' => $date, 'minutes' => (int) floor($sessions->filter(fn ($s) => $s->completed_at->setTimezone($today->timezone)->toDateString() === $date)->sum('elapsed_seconds') / 60)];
        });

        return response()->json(['total_tasks' => $total, 'completed_tasks' => $completed, 'completion_rate' => $total ? round($completed / $total * 100) : 0, 'overdue_tasks' => (clone $tasks)->whereNotIn('status', ['completed', 'cancelled'])->where('due_at', '<', now())->count(), 'focus_minutes' => (int) floor($sessions->sum('elapsed_seconds') / 60), 'estimated_minutes' => (clone $tasks)->sum('estimated_minutes'), 'actual_minutes' => (clone $tasks)->sum('actual_minutes'), 'days' => $days, 'today' => $today->toDateString()]);
    }

    public function export(Request $request): JsonResponse
    {
        app(AuditLogger::class)->log($request->user(), 'data_exported', $request);
        $data = ['profile' => $request->user()->only('name', 'email'), 'exported_at' => now()->toIso8601String()];
        foreach (self::MODELS as $key => $model) {
            $data[$key] = $model::where('user_id', $request->user()->id)->get()->makeHidden('user_id');
        } $data['settings'] = UserSetting::where('user_id', $request->user()->id)->first()?->preferences;
        $data['focus_sessions'] = FocusSession::where('user_id', $request->user()->id)->get()->makeHidden('user_id');
        $data['event_exceptions'] = CalendarEventException::whereIn('calendar_event_id', CalendarEvent::where('user_id', $request->user()->id)->select('id'))->get();
        $data['daily_checkins'] = DailyCheckin::where('user_id', $request->user()->id)->orderBy('date')->get();
        $data['assistant_proposals'] = AssistantProposal::where('user_id', $request->user()->id)->get();
        $data['automation_rules'] = AutomationRule::where('user_id', $request->user()->id)->get();
        $data['automation_runs'] = AutomationRun::where('user_id', $request->user()->id)->latest()->limit(1000)->get();
        $data['habit_entries'] = HabitEntry::whereIn('habit_id', Habit::where('user_id', $request->user()->id)->select('id'))->get();

        return response()->json($data);
    }
}
