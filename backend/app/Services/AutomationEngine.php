<?php

namespace App\Services;

use App\Models\AutomationRule;
use App\Models\AutomationRun;
use App\Models\FocusSession;
use App\Models\Task;
use App\Models\User;
use App\Models\WeeklyReview;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Rule engine with a fixed catalogue of triggers and actions. Rules only read and change their owner's data,
 * each (rule, subject) pair runs at most once (unique dedupe key), failures are logged and retried safely,
 * and every action is either a reversible change or a suggestion the user still has to approve.
 */
class AutomationEngine
{
    public const MAX_RULES = 20;

    public const MAX_ATTEMPTS = 3;

    /** Trigger => allowed actions. */
    public const CATALOGUE = [
        'task_overdue' => ['suggest_time_block', 'notify'],
        'focus_completed' => ['update_focus_stats', 'notify'],
        'recurring_task_due' => ['create_next_occurrence', 'notify'],
        'weekly_review_completed' => ['offer_next_week_plan', 'notify'],
        'day_overloaded' => ['suggest_rebalance', 'notify'],
    ];

    /** Triggers evaluated by the scheduler; the others fire from events. */
    public const POLLED = ['task_overdue', 'recurring_task_due', 'day_overloaded'];

    public const PRIORITIES = ['low' => 0, 'medium' => 1, 'high' => 2, 'urgent' => 3];

    public function __construct(private AssistantActions $assistant, private PlanningService $planning, private Notifier $notifier) {}

    /**
     * Ready-made rules users can add with one click (the examples from the product brief).
     *
     * @return list<array{key: string, trigger: string, action: string, conditions: array<string, mixed>, en: string, ar: string}>
     */
    public static function templates(): array
    {
        return [
            ['key' => 'overdue_block', 'trigger' => 'task_overdue', 'action' => 'suggest_time_block', 'conditions' => ['min_priority' => 'medium', 'overdue_hours' => 2], 'en' => 'Suggest a time block for overdue tasks', 'ar' => 'اقترح وقتاً للمهام المتأخرة'],
            ['key' => 'focus_stats', 'trigger' => 'focus_completed', 'action' => 'update_focus_stats', 'conditions' => ['min_minutes' => 10], 'en' => 'Update progress when a focus session ends', 'ar' => 'حدّث التقدم عند انتهاء جلسة تركيز'],
            ['key' => 'recurring_next', 'trigger' => 'recurring_task_due', 'action' => 'create_next_occurrence', 'conditions' => ['grace_hours' => 12], 'en' => 'Keep routines going: create the next occurrence when a recurring task is due', 'ar' => 'حافظ على الروتين: أنشئ التكرار التالي عند حلول موعد مهمة متكررة'],
            ['key' => 'review_plan', 'trigger' => 'weekly_review_completed', 'action' => 'offer_next_week_plan', 'conditions' => [], 'en' => 'Offer next week’s plan after the weekly review', 'ar' => 'اعرض خطة الأسبوع القادم بعد المراجعة الأسبوعية'],
            ['key' => 'overload_rebalance', 'trigger' => 'day_overloaded', 'action' => 'suggest_rebalance', 'conditions' => ['threshold' => 90, 'days_ahead' => 2], 'en' => 'Suggest moving flexible tasks off overloaded days', 'ar' => 'اقترح نقل المهام المرنة من الأيام المزدحمة'],
        ];
    }

    /**
     * Validation rules for a rule definition (trigger/action compatibility checked separately).
     *
     * @return array<string, mixed>
     */
    public static function validationRules(bool $partial = false): array
    {
        $req = $partial ? 'sometimes' : 'required';

        return [
            'name' => "{$req}|string|max:120",
            'trigger' => "{$req}|in:".implode(',', array_keys(self::CATALOGUE)),
            'action' => "{$req}|string|max:40",
            'enabled' => 'sometimes|boolean',
            'conditions' => 'sometimes|nullable|array:min_priority,overdue_hours,project_id,min_minutes,grace_hours,threshold,days_ahead',
            'conditions.min_priority' => 'nullable|in:low,medium,high,urgent',
            'conditions.overdue_hours' => 'nullable|integer|min:0|max:720',
            'conditions.project_id' => 'nullable|integer',
            'conditions.min_minutes' => 'nullable|integer|min:1|max:600',
            'conditions.grace_hours' => 'nullable|integer|min:0|max:168',
            'conditions.threshold' => 'nullable|integer|min:50|max:150',
            'conditions.days_ahead' => 'nullable|integer|min:1|max:7',
            'action_config' => 'sometimes|nullable|array:message',
            'action_config.message' => 'nullable|string|max:200',
        ];
    }

    public static function assertCompatible(string $trigger, string $action): void
    {
        if (! in_array($action, self::CATALOGUE[$trigger] ?? [], true)) {
            throw ValidationException::withMessages(['action' => ['This action is not available for the selected trigger.']]);
        }
    }

    /**
     * Evaluate every enabled polled rule (scheduler).
     */
    public function runScheduled(): void
    {
        AutomationRule::where('enabled', true)->whereIn('trigger', self::POLLED)->with('user')->orderBy('id')->chunkById(100, function (Collection $rules): void {
            foreach ($rules as $rule) {
                foreach ($this->subjects($rule) as $subject) {
                    $this->execute($rule, $subject);
                }
            }
        });
    }

    /**
     * Fire event-driven rules for a subject, e.g. a finished focus session.
     */
    public function fire(User $user, string $trigger, object $subject): void
    {
        foreach (AutomationRule::where('user_id', $user->id)->where('trigger', $trigger)->where('enabled', true)->get() as $rule) {
            $rule->setRelation('user', $user);
            if ($this->matches($rule, $subject)) {
                $this->execute($rule, ['key' => $this->subjectKey($trigger, $subject), 'label' => $this->subjectLabel($subject), 'model' => $subject]);
            }
        }
    }

    /**
     * What a rule would do right now, without changing anything.
     *
     * @return list<array{subject: string, description: string}>
     */
    public function preview(User $user, string $trigger, string $action, array $conditions): array
    {
        $rule = new AutomationRule(['user_id' => $user->id, 'trigger' => $trigger, 'action' => $action, 'conditions' => $conditions]);
        $rule->setRelation('user', $user);
        $subjects = in_array($trigger, self::POLLED, true) ? $this->subjects($rule) : $this->recentEventSubjects($rule);

        return collect($subjects)->take(10)->map(fn (array $s) => ['subject' => $s['label'], 'description' => $this->describe($action, $s, $user)])->values()->all();
    }

    /**
     * Run a rule for one subject once. Retries a previous failure up to MAX_ATTEMPTS.
     *
     * @param  array{key: string, label: string, model: mixed}  $subject
     */
    public function execute(AutomationRule $rule, array $subject): ?AutomationRun
    {
        $key = mb_substr($subject['key'], 0, 120);
        $inserted = AutomationRun::insertOrIgnore(['automation_rule_id' => $rule->id, 'user_id' => $rule->user_id, 'dedupe_key' => $key, 'status' => 'running', 'subject' => mb_substr($subject['label'], 0, 120), 'attempts' => 1, 'created_at' => now(), 'updated_at' => now()]);
        if (! $inserted) {
            $claimed = AutomationRun::where('automation_rule_id', $rule->id)->where('dedupe_key', $key)->where('status', 'failed')->where('attempts', '<', self::MAX_ATTEMPTS)
                ->update(['status' => 'running', 'attempts' => DB::raw('attempts + 1'), 'updated_at' => now()]);
            if (! $claimed) {
                return null;
            }
        }
        $run = AutomationRun::where('automation_rule_id', $rule->id)->where('dedupe_key', $key)->first();
        try {
            [$status, $message, $result] = DB::transaction(fn () => $this->perform($rule, $subject));
            $run->update(['status' => $status, 'message' => $message, 'result' => $result, 'error' => null]);
            $rule->forceFill(['run_count' => $rule->run_count + 1, 'last_run_at' => now()])->save();
        } catch (Throwable $e) {
            report($e);
            $run->update(['status' => 'failed', 'error' => mb_substr($e->getMessage(), 0, 300)]);
        }

        return $run->fresh();
    }

    /**
     * @param  array{key: string, label: string, model: mixed}  $subject
     * @return array{0: string, 1: string, 2: array<string, mixed>}
     */
    private function perform(AutomationRule $rule, array $subject): array
    {
        $user = $rule->user;
        $ar = ($user->preferences()['language'] ?? 'en') === 'ar';
        $model = $subject['model'];
        $custom = $rule->action_config['message'] ?? null;

        switch ($rule->action) {
            case 'notify':
                $this->notifier->send($user, $this->categoryFor($rule->trigger), "auto:{$rule->id}:{$subject['key']}", $custom ?: ($ar ? "أتمتة «{$rule->name}»: " : "Automation “{$rule->name}”: ").$subject['label'], ['link' => $this->linkFor($rule->trigger), 'kind' => 'automation']);

                return ['succeeded', $ar ? 'أُرسل إشعار.' : 'Notification sent.', []];

            case 'suggest_time_block':
                $task = Task::where('user_id', $user->id)->whereKey($model->id)->whereNotIn('status', ['completed', 'cancelled'])->first();
                if (! $task) {
                    return ['skipped', $ar ? 'لم تعد المهمة مفتوحة.' : 'The task is no longer open.', []];
                }
                $tz = $user->timezone();
                $now = CarbonImmutable::now($tz);
                $day = $now->format('H:i') < ($this->planning->config($user)['work_end']) ? $now : $now->addDay();
                $proposal = $this->assistant->proposeSchedule($user, $day->toDateString(), max(30, min(240, $task->estimated_minutes)), [['title' => $task->title, 'task_id' => $task->id, 'minutes' => max(30, min(240, $task->estimated_minutes))]], null, $ar, 'automation');
                if ($proposal->actions === []) {
                    return ['skipped', $ar ? 'لا يوجد وقت متاح قريباً.' : 'No free time available soon.', ['proposal' => $proposal->id]];
                }
                $this->notifier->send($user, 'deadlines', "auto:{$rule->id}:{$subject['key']}", $custom ?: ($ar ? "اقتراح وقت لـ «{$task->title}» المتأخرة" : "Suggested time for overdue “{$task->title}”"), ['body' => $ar ? 'راجع الاقتراح ووافق عليه لإضافته إلى التقويم.' : 'Review and approve it to add it to your calendar.', 'link' => "/assistant?proposal={$proposal->id}", 'kind' => 'automation']);

                return ['succeeded', $ar ? 'أُنشئ اقتراح بانتظار موافقتك.' : 'Created a suggestion awaiting your approval.', ['proposal' => $proposal->id]];

            case 'update_focus_stats':
                $changed = false;
                if ($model->task_id) {
                    $changed = (bool) Task::where('user_id', $user->id)->whereKey($model->task_id)->whereIn('status', ['inbox', 'todo'])->update(['status' => 'in_progress']);
                }
                $tz = $user->timezone();
                $today = CarbonImmutable::now($tz)->startOfDay();
                $sessions = FocusSession::where('user_id', $user->id)->where('status', 'completed')->whereIn('kind', ['focus', 'manual'])->where('completed_at', '>=', $today->utc())->get();
                $minutes = (int) floor($sessions->sum('elapsed_seconds') / 60);
                $this->notifier->send($user, 'focus', "auto:{$rule->id}:{$subject['key']}", $custom ?: ($ar ? "اليوم: {$minutes} دقيقة تركيز في {$sessions->count()} جلسة" : "Today: {$minutes} focused minutes across {$sessions->count()} session(s)"), ['link' => '/analytics', 'kind' => 'automation']);

                return ['succeeded', ($ar ? "إجمالي اليوم {$minutes} دقيقة." : "Today’s total is {$minutes} minutes.").($changed ? ($ar ? ' نُقلت المهمة إلى قيد التنفيذ.' : ' Task moved to in progress.') : ''), ['minutes_today' => $minutes, 'task_updated' => $changed]];

            case 'create_next_occurrence':
                $task = Task::where('user_id', $user->id)->whereKey($model->id)->lockForUpdate()->first();
                if (! $task || ! $task->recurrence || in_array($task->status, ['completed', 'cancelled'], true)) {
                    return ['skipped', $ar ? 'لم تعد المهمة متكررة أو مفتوحة.' : 'The task is no longer an open recurring task.', []];
                }
                if ($this->nextExists($task)) {
                    return ['skipped', $ar ? 'التكرار التالي موجود بالفعل.' : 'The next occurrence already exists.', []];
                }
                $next = $task->createNextOccurrence();
                $step = $task->recurrence === 'weekly' ? 7 : 1;
                $due = $next->due_at;
                for ($i = 0; $due <= now() && $i < 400; $i++) {
                    $due = $due->addDays($step);
                }
                $next->update(['due_at' => $due]);

                return ['succeeded', ($ar ? 'أُنشئ التكرار التالي بتاريخ ' : 'Created the next occurrence due ').$next->due_at->setTimezone($user->timezone())->format('Y-m-d H:i').($ar ? '. بقيت المهمة الفائتة كما هي لتقرر بشأنها.' : '. The missed one is left for you to decide.'), ['task_id' => $next->id]];

            case 'offer_next_week_plan':
                $start = CarbonImmutable::parse($model->week_start, $user->timezone())->addWeek();
                $priorities = array_values(array_filter(array_map('intval', (array) ($model->priorities ?? []))));
                $proposal = $this->planning->generate($user, $start->toDateString(), 7, [], $priorities);
                $this->notifier->send($user, 'planning', "auto:{$rule->id}:{$subject['key']}", $custom ?: ($ar ? 'خطة الأسبوع القادم جاهزة للمراجعة' : 'Next week’s plan is ready to review'), ['body' => $ar ? 'لن يُضاف شيء إلى التقويم قبل موافقتك.' : 'Nothing is added to your calendar until you accept it.', 'link' => '/planning', 'kind' => 'automation']);

                return ['succeeded', $ar ? 'أُنشئت مسودة خطة بانتظار موافقتك.' : 'Drafted a plan awaiting your approval.', ['schedule_proposal' => $proposal->id]];

            case 'suggest_rebalance':
                $proposal = $this->assistant->proposeRebalance($user, $ar, 'automation');
                if ($proposal->actions === []) {
                    return ['skipped', $proposal->summary, []];
                }
                $this->notifier->send($user, 'planning', "auto:{$rule->id}:{$subject['key']}", $custom ?: ($ar ? "يوم {$subject['label']} مزدحم — اقتراح لإعادة التوزيع" : "{$subject['label']} is overloaded — rebalancing suggested"), ['link' => "/assistant?proposal={$proposal->id}", 'kind' => 'automation']);

                return ['succeeded', $ar ? 'أُنشئ اقتراح بانتظار موافقتك.' : 'Created a suggestion awaiting your approval.', ['proposal' => $proposal->id]];
        }

        throw new \LogicException('Unknown automation action.');
    }

    /**
     * Current subjects for a polled rule.
     *
     * @return list<array{key: string, label: string, model: mixed}>
     */
    private function subjects(AutomationRule $rule): array
    {
        $user = $rule->user;
        $c = $rule->conditions ?? [];
        switch ($rule->trigger) {
            case 'task_overdue':
                $min = self::PRIORITIES[$c['min_priority'] ?? 'low'] ?? 0;
                $priorities = array_keys(array_filter(self::PRIORITIES, fn (int $rank) => $rank >= $min));

                return Task::where('user_id', $user->id)->whereNotIn('status', ['completed', 'cancelled'])->whereNotNull('due_at')
                    ->where('due_at', '<', now()->subHours((int) ($c['overdue_hours'] ?? 0)))->where('due_at', '>', now()->subDays(30))
                    ->whereIn('priority', $priorities)->when($c['project_id'] ?? null, fn ($q, $id) => $q->where('project_id', $id))
                    ->orderBy('due_at')->limit(20)->get()
                    ->map(fn (Task $t) => ['key' => "task:{$t->id}:{$t->due_at->timestamp}", 'label' => $t->title, 'model' => $t])->all();

            case 'recurring_task_due':
                return Task::where('user_id', $user->id)->whereNotNull('recurrence')->whereNotIn('status', ['completed', 'cancelled'])->whereNotNull('due_at')
                    ->where('due_at', '<', now()->subHours((int) ($c['grace_hours'] ?? 0)))->where('due_at', '>', now()->subDays(30))
                    ->orderBy('due_at')->limit(20)->get()
                    ->map(fn (Task $t) => ['key' => "recurring:{$t->id}:{$t->due_at->timestamp}", 'label' => $t->title, 'model' => $t])->all();

            case 'day_overloaded':
                $threshold = (int) ($c['threshold'] ?? 90);
                $days = (int) ($c['days_ahead'] ?? 2);
                $summary = $this->planning->summary($user, CarbonImmutable::now($user->timezone())->startOfDay(), $days, [], []);

                return collect($summary['days'])->filter(fn (array $d) => $d['work_day'] && $d['load_percent'] >= $threshold)
                    ->map(fn (array $d) => ['key' => "day:{$d['date']}", 'label' => $d['date'], 'model' => (object) $d])->values()->all();
        }

        return [];
    }

    /**
     * Recent matching events for previewing event-driven rules.
     *
     * @return list<array{key: string, label: string, model: mixed}>
     */
    private function recentEventSubjects(AutomationRule $rule): array
    {
        $models = match ($rule->trigger) {
            'focus_completed' => FocusSession::where('user_id', $rule->user_id)->where('status', 'completed')->where('completed_at', '>=', now()->subDays(7))->latest('completed_at')->limit(10)->get(),
            'weekly_review_completed' => WeeklyReview::where('user_id', $rule->user_id)->where('status', 'completed')->latest('completed_at')->limit(3)->get(),
            default => collect(),
        };

        return $models->filter(fn ($m) => $this->matches($rule, $m))->map(fn ($m) => ['key' => $this->subjectKey($rule->trigger, $m), 'label' => $this->subjectLabel($m), 'model' => $m])->values()->all();
    }

    private function matches(AutomationRule $rule, object $subject): bool
    {
        if ($rule->trigger === 'focus_completed') {
            return $subject instanceof FocusSession && $subject->elapsed_seconds >= 60 * (int) ($rule->conditions['min_minutes'] ?? 1);
        }

        return $rule->trigger !== 'weekly_review_completed' || $subject instanceof WeeklyReview;
    }

    private function subjectKey(string $trigger, object $subject): string
    {
        return $trigger === 'focus_completed' ? "focus:{$subject->id}" : "review:{$subject->id}:".($subject->completed_at?->timestamp ?? 0);
    }

    private function subjectLabel(object $subject): string
    {
        if ($subject instanceof FocusSession) {
            $title = $subject->task_id ? Task::whereKey($subject->task_id)->value('title') : null;

            return trim(((int) floor($subject->elapsed_seconds / 60)).' min'.($title ? " · {$title}" : ''));
        }

        return $subject instanceof WeeklyReview ? 'Week of '.$subject->week_start : (string) ($subject->label ?? '');
    }

    private function describe(string $action, array $subject, User $user): string
    {
        $ar = ($user->preferences()['language'] ?? 'en') === 'ar';

        return match ($action) {
            'notify' => $ar ? 'إرسال إشعار' : 'Send a notification',
            'suggest_time_block' => $ar ? 'اقتراح وقت في التقويم (يتطلب موافقتك)' : 'Suggest a calendar block (needs your approval)',
            'update_focus_stats' => $ar ? 'تحديث حالة المهمة وإرسال ملخص التركيز اليومي' : 'Mark the task in progress and send today’s focus summary',
            'create_next_occurrence' => $this->nextExists($subject['model']) ? ($ar ? 'لا شيء — التكرار التالي موجود' : 'Nothing — the next occurrence already exists') : ($ar ? 'إنشاء التكرار التالي (تبقى الفائتة كما هي)' : 'Create the next occurrence (the missed one stays as is)'),
            'offer_next_week_plan' => $ar ? 'إعداد مسودة خطة الأسبوع القادم (تتطلب موافقتك)' : 'Draft next week’s plan (needs your approval)',
            'suggest_rebalance' => $ar ? 'اقتراح نقل فترات مرنة (يتطلب موافقتك)' : 'Suggest moving flexible blocks (needs your approval)',
            default => $action,
        };
    }

    private function nextExists(mixed $task): bool
    {
        return $task instanceof Task && Task::where('user_id', $task->user_id)->where('id', '!=', $task->id)->where('title', $task->title)->where('recurrence', $task->recurrence)
            ->whereNotIn('status', ['completed', 'cancelled'])->where('due_at', '>', $task->due_at)->exists();
    }

    private function categoryFor(string $trigger): string
    {
        return ['task_overdue' => 'deadlines', 'focus_completed' => 'focus', 'recurring_task_due' => 'reminders', 'weekly_review_completed' => 'review', 'day_overloaded' => 'planning'][$trigger] ?? 'system';
    }

    private function linkFor(string $trigger): string
    {
        return ['task_overdue' => '/tasks', 'focus_completed' => '/focus', 'recurring_task_due' => '/tasks', 'weekly_review_completed' => '/planning', 'day_overloaded' => '/calendar'][$trigger] ?? '/';
    }
}
