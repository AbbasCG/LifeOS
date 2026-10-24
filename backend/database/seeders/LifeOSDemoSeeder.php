<?php

namespace Database\Seeders;

use App\Console\Commands\DemoData;
use App\Demo\DemoMode;
use App\Models\AssistantProposal;
use App\Models\AutomationRule;
use App\Models\AutomationRun;
use App\Models\CalendarEvent;
use App\Models\CalendarEventException;
use App\Models\Category;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\InboxNotification;
use App\Models\Project;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Models\WeeklyReview;
use App\Services\AssistantActions;
use App\Services\PlanningService;
use App\Services\WeeklyReviewService;
use Carbon\CarbonImmutable;
use Database\Seeders\Demo\DemoContent;
use Illuminate\Database\Seeder;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Realistic, interconnected demo data for one local demo account.
 *
 * Safety: runs only when DemoMode::allowed() (local/testing + LIFEOS_DEMO_ENABLED=true); touches only the account with the
 * configured demo email that is marked as a demo account; rows are written directly (no notifications are sent, no jobs are
 * queued, no external calendars or AI providers are contacted); re-running first removes the previous demo records, so the
 * result is idempotent. Randomness uses a fixed seed and dates are relative to "today" in the demo timezone.
 *
 * Run with: php artisan lifeos:demo   (or php artisan db:seed --class=LifeOSDemoSeeder)
 */
class LifeOSDemoSeeder extends Seeder
{
    public const SEED = 20261024;

    /** en | ar — language of the demo content and the account's interface. */
    public string $language = 'en';

    /** Explicit password for the demo account; null keeps an existing password or generates one for a new account. */
    public ?string $password = null;

    /** Set when a password was generated for a newly created account, so the command can show it once. */
    public ?string $generatedPassword = null;

    private User $user;

    private bool $ar = false;

    private string $tz;

    private CarbonImmutable $today;

    /** @var array<string, int> */
    private array $categories = [];

    /** @var array<string, int> */
    private array $projects = [];

    /** @var array<string, int> */
    private array $goals = [];

    /** @var Collection<int, Task> */
    private Collection $tasks;

    /** @var array<string, int> */
    private array $counts = [];

    public function run(): void
    {
        DemoMode::assertAllowed();
        mt_srand(self::SEED);
        $this->ar = $this->language === 'ar';
        $this->tz = (string) config('demo.timezone');
        $this->today = CarbonImmutable::now($this->tz)->startOfDay();

        DB::transaction(function () {
            $this->account();
            $this->organisation();
            $this->tasks();
            $this->habits();
            $this->calendar();
            $this->focus();
            $this->weeklyPlans();
            $this->reviews();
            $this->automations();
            $this->notifications();
        });
        $this->command?->getOutput()?->writeln('  Demo data: '.collect($this->counts)->map(fn (int $n, string $k) => "{$k} {$n}")->implode(', '));
        if ($this->generatedPassword && $this->command && ! $this->command instanceof DemoData) {
            $this->command->getOutput()->writeln('  Demo login: '.config('demo.email').' / '.$this->generatedPassword.' (shown once)');
        }
    }

    /**
     * @return array<string, int>
     */
    public function counts(): array
    {
        return $this->counts;
    }

    public function user(): User
    {
        return $this->user;
    }

    private function account(): void
    {
        $existing = DemoMode::user();
        if ($existing) {
            DemoMode::reset($existing);
            $this->user = $existing;
            $this->user->forceFill(['name' => $this->ar ? 'نور الحداد' : 'Noor Haddad'] + ($this->password ? ['password' => Hash::make($this->password)] : []))->save();
        } else {
            $password = $this->password ?? ($this->generatedPassword = Str::password(20, symbols: false));
            $this->user = User::forceCreate(['name' => $this->ar ? 'نور الحداد' : 'Noor Haddad', 'email' => config('demo.email'), 'password' => Hash::make($password), 'email_verified_at' => now()]);
        }
        UserSetting::updateOrCreate(['user_id' => $this->user->id], ['preferences' => [
            DemoMode::MARKER => true,
            'language' => $this->language, 'theme' => 'system', 'timezone' => $this->tz,
            'work_start' => '09:00', 'work_end' => '17:30', 'work_days' => [1, 2, 3, 4, 5], 'week_start' => 1, 'time_format' => '24',
            'break_minutes' => 10, 'focus_block_minutes' => 60, 'focus_start' => '09:30', 'focus_end' => '12:00', 'daily_focus_limit' => 300,
            'notifications' => true, 'quiet_start' => '22:00', 'quiet_end' => '07:00', 'event_remind_minutes' => 15,
            // The demo never sends data to an external AI provider, even when one is configured on the server.
            'assistant_external' => false,
        ]]);
    }

    private function organisation(): void
    {
        foreach (DemoContent::CATEGORIES as $key => [$en, $ar, $color]) {
            $this->categories[$key] = Category::create(['user_id' => $this->user->id, 'title' => $this->ar ? $ar : $en, 'color' => $color, 'created_at' => $this->today->subDays(90)])->id;
        }
        foreach (DemoContent::PROJECTS as $key => [$en, $ar, $descEn, $descAr, $color, $status, $due, $milestones]) {
            $this->projects[$key] = Project::create([
                'user_id' => $this->user->id, 'title' => $this->ar ? $ar : $en, 'description' => $this->ar ? $descAr : $descEn, 'color' => $color, 'status' => $status,
                'due_at' => $this->at($due, '17:00'), 'milestones' => array_map(fn (array $m) => ['title' => $this->ar ? $m[1] : $m[0], 'completed' => $m[2]], $milestones),
                'created_at' => $this->today->subDays(60 + mt_rand(0, 20)),
            ])->id;
        }
        foreach (DemoContent::GOALS as $key => [$en, $ar, $target, $progress, $due, $color]) {
            $this->goals[$key] = Goal::create(['user_id' => $this->user->id, 'title' => $this->ar ? $ar : $en, 'target' => $target, 'progress' => $progress, 'due_at' => $this->at($due, '23:00'), 'color' => $color, 'created_at' => $this->today->subDays(120)])->id;
        }
        $this->counts += ['categories' => count($this->categories), 'projects' => count($this->projects), 'goals' => count($this->goals)];
    }

    private function tasks(): void
    {
        $steps = [['Outline', 'المخطط'], ['First draft', 'المسودة الأولى'], ['Review & polish', 'المراجعة والتحسين']];
        $this->tasks = collect();
        foreach (DemoContent::TASKS as $i => [$en, $ar, $project, $goal, $category, $priority, $estimate, $state, $tags]) {
            [$kind, $days] = array_pad(explode(':', $state), 2, '0');
            $days = (int) $days;
            $attrs = [
                'user_id' => $this->user->id, 'title' => $this->ar ? $ar : $en, 'priority' => $priority, 'estimated_minutes' => $estimate,
                'project_id' => $project ? $this->projects[$project] : null, 'goal_id' => $goal ? $this->goals[$goal] : null, 'category_id' => $this->categories[$category],
                'tags' => $tags, 'status' => 'todo', 'actual_minutes' => 0,
            ];
            switch ($kind) {
                case 'done':
                    $completed = $this->at(-$days, sprintf('%02d:%02d', mt_rand(10, 17), mt_rand(0, 3) * 15));
                    $late = mt_rand(0, 5) === 0;
                    $attrs = array_merge($attrs, ['status' => 'completed', 'completed_at' => $completed, 'due_at' => $late ? $completed->subDay()->setTime(17, 0) : $completed->addDays(mt_rand(0, 3))->setTime(17, 0), 'created_at' => $completed->subDays(mt_rand(3, 14))]);
                    break;
                case 'open':
                    $attrs = array_merge($attrs, ['due_at' => $this->at($days, '17:00'), 'created_at' => $this->today->subDays(mt_rand(2, 12))]);
                    break;
                case 'overdue':
                    $attrs = array_merge($attrs, ['due_at' => $this->at(-$days, '17:00'), 'created_at' => $this->today->subDays($days + mt_rand(4, 10))]);
                    break;
                case 'doing':
                    $attrs = array_merge($attrs, ['status' => 'in_progress', 'due_at' => $this->at($days, '17:00'), 'created_at' => $this->today->subDays(mt_rand(5, 15))]);
                    break;
                case 'inbox':
                    $attrs = array_merge($attrs, ['status' => 'inbox', 'created_at' => $this->today->subDays(mt_rand(0, 3))]);
                    break;
                case 'someday':
                    $attrs = array_merge($attrs, ['created_at' => $this->today->subDays(mt_rand(10, 30))]);
                    break;
                case 'cancelled':
                    $attrs = array_merge($attrs, ['status' => 'cancelled', 'created_at' => $this->today->subDays(mt_rand(10, 25))]);
                    break;
                case 'daily':
                case 'weekly':
                    $attrs = array_merge($attrs, ['recurrence' => $kind, 'due_at' => $this->at($days, $kind === 'daily' ? '20:00' : '18:00'), 'created_at' => $this->today->subDays(40)]);
                    break;
            }
            if ($estimate >= 180) {
                $doneSteps = match ($attrs['status']) {
                    'completed' => 3, 'in_progress' => 1 + ($i % 2), default => 0
                };
                $attrs['subtasks'] = array_map(fn (array $s, int $n) => ['title' => $this->ar ? $s[1] : $s[0], 'completed' => $n < $doneSteps], $steps, array_keys($steps));
            }
            $attrs['updated_at'] = $attrs['completed_at'] ?? $attrs['created_at'];
            $this->tasks->push(Task::create($attrs));
        }
        // A task reminder for tomorrow morning and one that fired earlier today.
        $this->task('Register for the half marathon')->update(['remind_at' => $this->at(1, '09:00')]);
        $this->task('Invoice client C')->update(['remind_at' => $this->at(0, '08:30')]);
        $this->counts['tasks'] = $this->tasks->count();
    }

    private function habits(): void
    {
        $entries = 0;
        foreach (DemoContent::HABITS as $key => [$en, $ar, $recurrence, $routine, $rate, $streak]) {
            $habit = Habit::create(['user_id' => $this->user->id, 'title' => $this->ar ? $ar : $en, 'recurrence' => $recurrence, 'routine' => $routine, 'color' => '#16a34a', 'created_at' => $this->today->subDays(70)]);
            $dates = [];
            if ($recurrence === 'daily') {
                for ($d = 60; $d >= 1; $d--) {
                    $done = $d <= $streak ? true : ($d === $streak + 1 ? false : mt_rand(1, 100) <= $rate);
                    if ($done) {
                        $dates[] = $this->today->subDays($d)->toDateString();
                    }
                }
                if (in_array($key, ['water', 'meditate'], true)) {
                    $dates[] = $this->today->toDateString();
                }
            } else {
                $week = $this->today->startOfWeek(CarbonImmutable::MONDAY);
                for ($w = 9; $w >= 1; $w--) {
                    $done = $w <= $streak ? true : ($w === $streak + 1 ? false : mt_rand(1, 100) <= $rate);
                    if ($done) {
                        $dates[] = $week->subWeeks($w)->addDays(5 + mt_rand(0, 1))->toDateString();
                    }
                }
            }
            foreach ($dates as $date) {
                HabitEntry::create(['habit_id' => $habit->id, 'date' => $date]);
            }
            $entries += count($dates);
        }
        $this->counts += ['habits' => count(DemoContent::HABITS), 'habit_entries' => $entries];
    }

    private function calendar(): void
    {
        $t = fn (string $en, string $ar) => $this->ar ? $ar : $en;
        $monday = $this->today->startOfWeek(CarbonImmutable::MONDAY);
        $seriesStart = $monday->subWeeks(5);
        $series = fn (string $title, string $from, string $to, array $rule, string $kind, ?string $until = null, ?int $remind = null, int $startOffset = 0) => CalendarEvent::create([
            'user_id' => $this->user->id, 'title' => $title, 'kind' => $kind, 'timezone' => $this->tz, 'recurrence' => $rule, 'recurrence_until' => $until, 'remind_minutes' => $remind,
            'starts_at' => $seriesStart->addDays($startOffset)->setTimeFromTimeString($from)->utc(), 'ends_at' => $seriesStart->addDays($startOffset)->setTimeFromTimeString($to)->utc(),
        ]);

        $standup = $series($t('Team stand-up', 'الاجتماع اليومي للفريق'), '09:15', '09:30', ['freq' => 'weekly', 'interval' => 1, 'by_weekday' => [1, 2, 3, 4, 5]], 'fixed', null, 5);
        $series($t('Gym', 'النادي الرياضي'), '07:00', '08:00', ['freq' => 'weekly', 'interval' => 1, 'by_weekday' => [1, 3, 5]], 'flexible');
        $series($t('1:1 with Maya', 'لقاء فردي مع مايا'), '14:00', '14:30', ['freq' => 'weekly', 'interval' => 1, 'by_weekday' => [4]], 'fixed', null, 10, 3);
        $class = $series($t('Calligraphy class', 'درس الخط العربي'), '19:00', '20:30', ['freq' => 'weekly', 'interval' => 1, 'by_weekday' => [2]], 'fixed', $this->today->addDays(28)->toDateString(), 60, 1);
        $series($t('Long run', 'جري المسافات الطويلة'), '08:30', '10:00', ['freq' => 'weekly', 'interval' => 1, 'by_weekday' => [0]], 'flexible', null, null, 6);
        $series($t('Monthly budget review', 'المراجعة الشهرية للميزانية'), '10:00', '10:45', ['freq' => 'monthly', 'interval' => 1], 'flexible', null, null, 5);

        // Exceptions: the class is cancelled next week (teacher away); one stand-up becomes sprint planning.
        $nextTuesday = $monday->addWeek()->addDay();
        CalendarEventException::create(['calendar_event_id' => $class->id, 'original_start' => $nextTuesday->setTime(19, 0)->utc(), 'cancelled' => true]);
        $planningDay = $monday->subWeek();
        CalendarEventException::create(['calendar_event_id' => $standup->id, 'original_start' => $planningDay->setTime(9, 15)->utc(), 'title' => $t('Sprint planning', 'تخطيط السباق'), 'starts_at' => $planningDay->setTime(9, 0)->utc(), 'ends_at' => $planningDay->setTime(10, 0)->utc()]);

        // Minutes already taken per day offset, starting with the recurring series, so generated events never overlap
        // unless a scenario asks for it explicitly ($allowConflict).
        $minutes = fn (string $hm) => (int) substr($hm, 0, 2) * 60 + (int) substr($hm, 3, 2);
        $occupied = [];
        for ($day = -21; $day <= 14; $day++) {
            $dow = $this->today->addDays($day)->dayOfWeek;
            $occupied[$day] = array_values(array_filter([
                in_array($dow, [1, 2, 3, 4, 5], true) ? [555, 570] : null,
                in_array($dow, [1, 3, 5], true) ? [420, 480] : null,
                $dow === 4 ? [840, 870] : null,
                $dow === 2 ? [1140, 1230] : null,
                $dow === 0 ? [510, 600] : null,
                $this->today->addDays($day)->day === $seriesStart->addDays(5)->day ? [600, 645] : null,
            ]));
        }
        $single = 0;
        $event = function (int $day, string $from, string $to, string $title, string $kind = 'fixed', ?Task $task = null, ?string $description = null, bool $allowConflict = false) use (&$single, &$occupied, $minutes) {
            $range = [$minutes($from), $minutes($to)];
            foreach ($occupied[$day] ?? [] as [$a, $b]) {
                if (! $allowConflict && $range[0] < $b && $range[1] > $a) {
                    return null;
                }
            }
            $occupied[$day][] = $range;
            $single++;

            return CalendarEvent::create(['user_id' => $this->user->id, 'title' => $title, 'description' => $description, 'kind' => $kind, 'task_id' => $task?->id, 'starts_at' => $this->at($day, $from), 'ends_at' => $this->at($day, $to)]);
        };
        // Personal appointments.
        $event(-9, '08:15', '09:00', $t('Dentist', 'طبيب الأسنان'), 'fixed', $this->task('Book dentist appointment'));
        $event(-4, '18:30', '19:15', $t('Haircut', 'قص الشعر'));
        $event(3, '19:30', '22:00', $t('Dinner with friends', 'عشاء مع الأصدقاء'));
        $event(5, '19:00', '21:30', $t('Mum’s birthday dinner', 'عشاء عيد ميلاد أمي'), 'fixed', $this->task('Plan mum’s birthday dinner'));
        $event(12, '08:00', '08:40', $t('Physiotherapy', 'العلاج الطبيعي'));

        // A double booking to review in the calendar (as if added from two places), kept away from the overloaded day.
        $conflictDay = $this->nextWeekday(1);
        $event($conflictDay, '11:00', '11:45', $t('Doctor appointment', 'موعد الطبيب'), 'fixed', null, $t('Overlaps the vendor call — reschedule one of them.', 'يتعارض مع مكالمة المورّد — أعد جدولة أحدهما.'));
        $event($conflictDay, '11:30', '12:00', $t('Vendor call', 'مكالمة المورّد'), 'fixed', null, null, true);

        // An overloaded day with competing priorities.
        $busy = $this->nextWeekday(2, [$conflictDay]);
        $event($busy, '09:30', '12:00', $t('Design system workshop', 'ورشة نظام التصميم'));
        $event($busy, '12:00', '12:30', $t('Quick sync with engineering', 'تنسيق سريع مع الهندسة'));
        $event($busy, '13:00', '14:00', $t('Client review: Q4 dashboards', 'مراجعة العميل: لوحات الربع الرابع'));
        $event($busy, '14:00', '14:30', $t('Hiring debrief', 'مناقشة نتائج التوظيف'));
        $event($busy, '14:30', '16:00', $t('Stakeholder presentation', 'عرض لأصحاب المصلحة'));
        $event($busy, '16:00', '17:30', $this->task('Home page visual design')->title, 'flexible', $this->task('Home page visual design'));

        // Planned task blocks: completed in the past, missed in the past (open tasks), and upcoming.
        foreach ($this->tasks->where('status', 'completed')->whereNotNull('completed_at')->filter(fn (Task $task) => $task->completed_at > $this->today->subDays(21)) as $task) {
            $day = (int) $this->today->diffInDays($task->completed_at->setTimezone($this->tz)->startOfDay(), false);
            if ($this->today->addDays($day)->isWeekday() && $task->estimated_minutes >= 45) {
                $minutes = min(120, $task->estimated_minutes);
                $event($day, '13:30', $this->today->setTime(13, 30)->addMinutes($minutes)->format('H:i'), $task->title, 'flexible', $task);
            }
        }
        foreach (['Clean revenue spreadsheet' => -3, 'Watch lecture on gradient boosting' => -2] as $title => $day) {
            for ($try = 0, $placed = null; $try < 5 && ! $placed; $try++) {
                $placed = $event($this->previousWeekday($day - $try), '16:00', '17:00', $this->task($title)->title, 'flexible', $this->task($title));
            }
        }
        foreach (['Draft Q4 dashboards' => [0, '10:00', '11:30'], 'Executive summary slides' => [1, '14:30', '16:00'], 'Capstone: choose a dataset' => [1, '16:15', '17:15'], 'Design system: components' => [3, '09:45', '11:45']] as $title => $slot) {
            $day = $slot[0] === 0 ? 0 : $this->nextWeekday($slot[0], [$busy]);
            $event($day, $slot[1], $slot[2], $this->task($title)->title, 'flexible', $this->task($title));
        }
        // Ordinary meetings fill remaining gaps; next week is kept light so there is room for focus blocks.
        $meetings = [['Design critique', 'نقد التصميم'], ['Client sync', 'متابعة مع العميل'], ['Product demo', 'عرض المنتج'], ['Marketing sync', 'تنسيق مع التسويق'], ['Hiring interview', 'مقابلة توظيف'], ['Lunch with Omar', 'غداء مع عمر']];
        $slots = [['10:00', '11:00'], ['11:00', '11:45'], ['13:30', '14:00'], ['15:00', '16:00'], ['16:00', '16:30']];
        for ($day = -21; $day <= 14; $day++) {
            $date = $this->today->addDays($day);
            if ($date->isWeekend()) {
                continue;
            }
            $count = $day >= 7 && $day <= 11 ? mt_rand(0, 1) : mt_rand(1, 2);
            $used = [];
            for ($m = 0; $m < $count; $m++) {
                $slot = $slots[mt_rand(0, count($slots) - 1)];
                if (in_array($slot[0], $used, true) || in_array($day, [$conflictDay, $busy], true)) {
                    continue;
                }
                $used[] = $slot[0];
                $event($day, $slot[0], $slot[1], $t(...$meetings[mt_rand(0, count($meetings) - 1)]));
            }
        }

        $this->counts += ['recurring_series' => 6, 'events' => $single];
    }

    private function focus(): void
    {
        $sessions = 0;
        // Tasks used for the "missed block" scenario get no focus time, so the planner offers to reschedule them.
        $missed = [$this->task('Clean revenue spreadsheet')->id, $this->task('Watch lecture on gradient boosting')->id];
        $pool = $this->tasks->filter(fn (Task $t) => $t->project_id !== null && ! in_array($t->id, $missed, true) && in_array($t->status, ['completed', 'in_progress', 'todo'], true))->values();
        $durations = [1500, 1500, 3000, 3000, 3000, 5400];
        for ($day = 58; $day >= 0; $day--) {
            $date = $this->today->subDays($day);
            $isWeekend = $date->isWeekend();
            // Mid-week is the most productive; weekends are light; yesterday is a deliberately strong day.
            $count = $day === 1 ? 5 : ($isWeekend ? mt_rand(0, 1) : mt_rand(1, in_array($date->dayOfWeek, [2, 3], true) ? 4 : 3));
            if ($day === 0) {
                $count = min($count, 2);
            }
            $clock = $date->setTime(9, 30);
            for ($s = 0; $s < $count; $s++) {
                $duration = $durations[mt_rand(0, count($durations) - 1)];
                $cancelled = mt_rand(1, 100) <= 6;
                $elapsed = $cancelled ? mt_rand(4, 12) * 60 : (int) ($duration * mt_rand(80, 100) / 100);
                $start = $clock->addMinutes(mt_rand(0, 40));
                $end = $start->addSeconds($elapsed);
                if ($end > CarbonImmutable::now($this->tz)) {
                    break;
                }
                $task = $this->taskActiveOn($pool, $date);
                FocusSession::create([
                    'user_id' => $this->user->id, 'task_id' => $task?->id, 'kind' => mt_rand(1, 100) <= 8 ? 'manual' : 'focus', 'status' => $cancelled ? 'cancelled' : 'completed',
                    'duration_seconds' => $duration, 'elapsed_seconds' => $elapsed, 'completed_at' => $cancelled ? null : $end->utc(),
                    'created_at' => $start->utc(), 'updated_at' => $end->utc(),
                ]);
                $sessions++;
                $clock = $end->addMinutes($s === 1 ? 60 : 15);
            }
        }
        // Actual time on tasks comes from the logged focus sessions (planned vs actual), with a fallback for older work.
        $actual = FocusSession::where('user_id', $this->user->id)->where('status', 'completed')->whereNotNull('task_id')->selectRaw('task_id, sum(elapsed_seconds) as seconds')->groupBy('task_id')->pluck('seconds', 'task_id');
        foreach ($this->tasks as $task) {
            $minutes = (int) floor(($actual[$task->id] ?? 0) / 60);
            if ($task->status === 'completed' && $minutes === 0) {
                $minutes = (int) (round($task->estimated_minutes * mt_rand(70, 140) / 100 / 5) * 5);
            }
            if ($minutes > 0) {
                $task->forceFill(['actual_minutes' => $minutes])->saveQuietly();
            }
        }
        $this->counts['focus_sessions'] = $sessions;
    }

    private function weeklyPlans(): void
    {
        $planning = app(PlanningService::class);
        $monday = $this->today->startOfWeek(CarbonImmutable::MONDAY);
        for ($w = 3; $w >= 1; $w--) {
            $start = $monday->subWeeks($w);
            $blocks = CalendarEvent::where('user_id', $this->user->id)->whereNotNull('task_id')->whereNull('recurrence')
                ->whereBetween('starts_at', [$start->utc(), $start->addWeek()->utc()])->orderBy('starts_at')->get();
            $items = $blocks->map(function (CalendarEvent $e) {
                $task = $this->tasks->firstWhere('id', $e->task_id);

                return ['key' => $e->task_id.'-1-'.$e->starts_at->getTimestamp(), 'task_id' => $e->task_id, 'task_version' => $task->updated_at->toISOString(), 'title' => $task->title, 'priority' => $task->priority,
                    'starts_at' => $e->starts_at->utc()->toIso8601String(), 'ends_at' => $e->ends_at->utc()->toIso8601String(), 'minutes' => (int) $e->starts_at->diffInMinutes($e->ends_at),
                    'part' => 1, 'parts' => 1, 'manual' => false, 'reasons' => ['due_soon'], 'explanation' => ['en' => 'Placed before its deadline.', 'ar' => 'وُضعت قبل موعدها النهائي.']];
            })->values()->all();
            ScheduleProposal::create(['user_id' => $this->user->id, 'status' => 'accepted', 'starts_on' => $start->toDateString(), 'days' => 7, 'items' => $items, 'warnings' => [],
                'summary' => $planning->summary($this->user, $start, 7, $items, []), 'accepted_at' => $start->setTime(8, 30)->utc(), 'created_at' => $start->subDay()->setTime(18, 0)->utc()]);
        }
        // The upcoming week is drafted by the real planner and waits to be previewed, edited and accepted.
        $planning->generate($this->user, $monday->addWeek()->toDateString(), 7);
        $this->counts['weekly_plans'] = 4;
    }

    private function reviews(): void
    {
        $service = app(WeeklyReviewService::class);
        $monday = $this->today->startOfWeek(CarbonImmutable::MONDAY);
        $reflections = [
            ['Interviews gave clear direction for the redesign.', 'Too many meetings on Wednesday.', 'Block mornings for deep work.', 4, 'أعطت المقابلات اتجاهاً واضحاً لإعادة التصميم.', 'اجتماعات كثيرة يوم الأربعاء.', 'احجز الصباح للعمل العميق.'],
            ['Finished module 8 and kept the running plan.', 'Late nights hurt my mornings.', 'No screens after 22:00.', 3, 'أنهيت الوحدة ٨ والتزمت بخطة الجري.', 'السهر أثّر على صباحاتي.', 'لا شاشات بعد الساعة ٢٢.'],
            ['Shipped the design tokens and a 16 km run!', 'The revenue spreadsheet slipped again.', 'Do the smallest admin task first thing.', 5, 'سلّمت رموز التصميم وركضت ١٦ كم!', 'تأخر جدول الإيرادات مرة أخرى.', 'ابدأ بأصغر مهمة إدارية أول اليوم.'],
        ];
        foreach ([3, 2, 1] as $i => $w) {
            $start = $monday->subWeeks($w);
            [$wins, $challenges, $lessons, $rating, $winsAr, $challengesAr, $lessonsAr] = $reflections[$i];
            $priorities = $this->tasks->whereIn('status', ['todo', 'in_progress'])->where('priority', '!=', 'low')->take(3)->pluck('id')->all();
            $review = WeeklyReview::create(['user_id' => $this->user->id, 'week_start' => $start->toDateString(), 'status' => 'completed',
                'reflection' => ['wins' => $this->ar ? $winsAr : $wins, 'challenges' => $this->ar ? $challengesAr : $challenges, 'lessons' => $this->ar ? $lessonsAr : $lessons, 'rating' => $rating],
                'decisions' => [], 'priorities' => $priorities, 'completed_at' => $start->addDays(6)->setTime(18, 0)->utc()]);
            $review->update(['snapshot' => $service->build($this->user, $start)['metrics'] + ['applied' => ['done' => 0, 'drop' => 0, 'carry' => 0]]]);
        }
        $this->counts['weekly_reviews'] = 3;
    }

    private function automations(): void
    {
        $rule = fn (string $name, string $trigger, string $action, array $conditions, bool $enabled, int $runs, ?int $lastDays) => AutomationRule::create([
            'user_id' => $this->user->id, 'name' => $name, 'trigger' => $trigger, 'action' => $action, 'conditions' => $conditions, 'enabled' => $enabled,
            'run_count' => $runs, 'last_run_at' => $lastDays === null ? null : $this->today->subDays($lastDays)->setTime(16, 15)->utc(), 'created_at' => $this->today->subDays(30),
        ]);
        $t = fn (string $en, string $ar) => $this->ar ? $ar : $en;
        $overdue = $rule($t('Suggest a time block for overdue tasks', 'اقترح وقتاً للمهام المتأخرة'), 'task_overdue', 'suggest_time_block', ['min_priority' => 'high', 'overdue_hours' => 2], true, 3, 0);
        $focus = $rule($t('Update progress when a focus session ends', 'حدّث التقدم عند انتهاء جلسة تركيز'), 'focus_completed', 'update_focus_stats', ['min_minutes' => 10], true, 0, null);
        $recurring = $rule($t('Keep routines going', 'حافظ على الروتين'), 'recurring_task_due', 'create_next_occurrence', ['grace_hours' => 12], true, 1, 4);
        $rule($t('Offer next week’s plan after the review', 'اعرض خطة الأسبوع القادم بعد المراجعة'), 'weekly_review_completed', 'offer_next_week_plan', [], true, 2, 6);
        $rule($t('Suggest moving flexible tasks off overloaded days', 'اقترح نقل المهام المرنة من الأيام المزدحمة'), 'day_overloaded', 'suggest_rebalance', ['threshold' => 90, 'days_ahead' => 2], false, 0, null);
        $rule($t('Nudge me about overdue urgent tasks', 'نبّهني بشأن المهام العاجلة المتأخرة'), 'task_overdue', 'notify', ['min_priority' => 'urgent', 'overdue_hours' => 0], false, 4, 9);

        $log = fn (AutomationRule $r, string $key, string $status, string $subject, string $message, int $daysAgo, ?string $error = null, int $attempts = 1, array $result = []) => AutomationRun::create([
            'automation_rule_id' => $r->id, 'user_id' => $this->user->id, 'dedupe_key' => $key, 'status' => $status, 'subject' => $subject, 'message' => $message, 'error' => $error, 'attempts' => $attempts, 'result' => $result,
            'created_at' => $this->today->subDays($daysAgo)->setTime(16, 15)->utc(), 'updated_at' => $this->today->subDays($daysAgo)->setTime(16, 15 + $attempts)->utc(),
        ]);
        // Recent focus sessions were already processed by the focus rule.
        foreach (FocusSession::where('user_id', $this->user->id)->where('status', 'completed')->where('elapsed_seconds', '>=', 600)->latest('completed_at')->limit(5)->get() as $i => $session) {
            $log($focus, "focus:{$session->id}", 'succeeded', ((int) floor($session->elapsed_seconds / 60)).' min', $t('Task moved to in progress.', 'نُقلت المهمة إلى قيد التنفيذ.'), $i);
        }
        $focus->forceFill(['run_count' => 5, 'last_run_at' => now()])->save();
        $water = $this->task('Water plants');
        $log($recurring, 'recurring:'.$water->id.':'.$water->due_at->subDays(4)->timestamp, 'skipped', $water->title, $t('The next occurrence already exists.', 'التكرار التالي موجود بالفعل.'), 4);

        // An automation suggestion waiting for approval, produced with the real scheduling logic.
        $actions = app(AssistantActions::class);
        $spreadsheet = $this->task('Clean revenue spreadsheet');
        $day = $this->nextWeekday(5);
        $proposal = $actions->proposeSchedule($this->user, $this->today->addDays($day)->toDateString(), $spreadsheet->estimated_minutes, [['title' => $spreadsheet->title, 'task_id' => $spreadsheet->id, 'minutes' => $spreadsheet->estimated_minutes]], '13:00', $this->ar, 'automation');
        $log($overdue, "task:{$spreadsheet->id}:{$spreadsheet->due_at->timestamp}", 'succeeded', $spreadsheet->title, $t('Created a suggestion awaiting your approval.', 'أُنشئ اقتراح بانتظار موافقتك.'), 0, null, 1, ['proposal' => $proposal->id]);
        $invoice = $this->task('Invoice client C');
        $log($overdue, "task:{$invoice->id}:{$invoice->due_at->timestamp}", 'failed', $invoice->title, '', 1, $t('The calendar changed while the suggestion was being prepared.', 'تغيّر التقويم أثناء إعداد الاقتراح.'), 2);
        $this->notify('deadlines', 'automation', $t("Suggested time for overdue “{$spreadsheet->title}”", "اقتراح وقت لـ «{$spreadsheet->title}» المتأخرة"), $t('Review and approve it to add it to your calendar.', 'راجع الاقتراح ووافق عليه لإضافته إلى التقويم.'), "/assistant?proposal={$proposal->id}", 0, '16:15');

        // A pending assistant scheduling proposal (local assistant — no external AI call).
        $actions->proposeSchedule($this->user, $this->today->addDays($this->nextWeekday(4))->toDateString(), 240, [['title' => $t('Studying', 'الدراسة'), 'minutes' => null], ['title' => $t('Programming', 'البرمجة'), 'minutes' => null], ['title' => $t('Exercise', 'الرياضة'), 'minutes' => null]], null, $this->ar, 'local');
        $this->counts += ['automation_rules' => 6, 'automation_runs' => AutomationRun::where('user_id', $this->user->id)->count(), 'pending_proposals' => AssistantProposal::where('user_id', $this->user->id)->where('status', 'pending')->count()];
    }

    private function notifications(): void
    {
        $t = fn (string $en, string $ar) => $this->ar ? $ar : $en;
        $yesterday = FocusSession::where('user_id', $this->user->id)->where('status', 'completed')->whereBetween('completed_at', [$this->today->subDay()->utc(), $this->today->utc()])->get();
        $focusMinutes = (int) floor($yesterday->sum('elapsed_seconds') / 60);
        $focusCount = $yesterday->count();
        $items = [
            ['reminders', 'reminder', $t('Reminder: Invoice client C', 'تذكير: إصدار فاتورة للعميل ج'), null, '/tasks', 0, '08:30', false],
            ['deadlines', 'overdue', $t('Overdue: Renew passport', 'مهمة متأخرة: تجديد جواز السفر'), null, '/tasks', 0, '09:00', false],
            ['planning', 'planning', $t('Time to review today’s plan', 'حان وقت مراجعة خطة اليوم'), null, '/planning', 0, '09:00', false],
            ['calendar', 'event', $t('Upcoming: Team stand-up', 'موعد قادم: الاجتماع اليومي للفريق'), $t('Starts at 09:15', 'يبدأ الساعة 09:15'), '/calendar', 0, '09:10', true],
            ['focus', 'focus', $t('Focus session completed', 'اكتملت جلسة التركيز'), null, '/focus', 1, '11:20', true],
            ['focus', 'automation', $t("Today: {$focusMinutes} focused minutes across {$focusCount} sessions", "اليوم: {$focusMinutes} دقيقة تركيز في {$focusCount} جلسات"), null, '/analytics', 1, '17:40', true],
            ['deadlines', 'due', $t('Task due: Module 9 quiz', 'موعد المهمة: اختبار الوحدة ٩'), null, '/tasks', 2, '16:00', true],
            ['calendar', 'event', $t('Upcoming: Client review', 'موعد قادم: مراجعة العميل'), $t('Starts at 13:00', 'يبدأ الساعة 13:00'), '/calendar', 2, '12:45', true],
            ['deadlines', 'overdue', $t('Overdue: Clean revenue spreadsheet', 'مهمة متأخرة: تنظيف جدول الإيرادات'), null, '/tasks', 2, '17:05', true],
            ['reminders', 'reminder', $t('Reminder: Book physio check-up', 'تذكير: حجز موعد علاج طبيعي'), null, '/tasks', 3, '10:00', true],
            ['planning', 'planning', $t('Time to review today’s plan', 'حان وقت مراجعة خطة اليوم'), null, '/planning', 3, '09:00', true],
            ['review', 'review', $t('Review your week and plan the next', 'راجع أسبوعك وخطط للأسبوع القادم'), null, '/review', 6, '17:00', true],
            ['planning', 'automation', $t('Next week’s plan is ready to review', 'خطة الأسبوع القادم جاهزة للمراجعة'), $t('Nothing is added to your calendar until you accept it.', 'لن يُضاف شيء إلى التقويم قبل موافقتك.'), '/planning', 6, '18:05', true],
            ['calendar', 'event', $t('Upcoming: Calligraphy class', 'موعد قادم: درس الخط العربي'), $t('Starts at 19:00', 'يبدأ الساعة 19:00'), '/calendar', 7, '18:00', true],
            ['focus', 'focus', $t('Focus session completed', 'اكتملت جلسة التركيز'), null, '/focus', 8, '10:55', true],
            ['deadlines', 'due', $t('Task due: Set up automatic transfer', 'موعد المهمة: إعداد تحويل تلقائي'), null, '/tasks', 8, '16:00', true],
            ['system', 'info', $t('Welcome to LifeOS — this is a demo workspace', 'مرحباً بك في LifeOS — هذه مساحة عمل تجريبية'), $t('Everything here is sample data you can change or reset.', 'كل ما هنا بيانات تجريبية يمكنك تعديلها أو إعادة ضبطها.'), '/', 30, '09:00', true],
        ];
        foreach ($items as [$category, $kind, $title, $body, $link, $days, $time, $read]) {
            $this->notify($category, $kind, $title, $body, $link, $days, $time, $read);
        }
        $this->counts['notifications'] = InboxNotification::where('user_id', $this->user->id)->count();
    }

    private function notify(string $category, string $kind, string $title, ?string $body, string $link, int $daysAgo, string $time, bool $read = false): void
    {
        $at = $this->today->subDays($daysAgo)->setTimeFromTimeString($time);
        if ($at > CarbonImmutable::now($this->tz)) {
            $at = CarbonImmutable::now($this->tz)->subMinutes(5);
        }
        InboxNotification::create(['user_id' => $this->user->id, 'category' => $category, 'kind' => $kind, 'title' => $title, 'body' => $body, 'link' => $link,
            'deduplication_key' => 'demo:'.$this->user->id.':'.Str::uuid(), 'read_at' => $read ? $at->addHour()->utc() : null, 'created_at' => $at->utc(), 'updated_at' => $at->utc()]);
    }

    private function at(int $days, string $time): CarbonImmutable
    {
        return $this->today->addDays($days)->setTimeFromTimeString($time)->utc();
    }

    /**
     * Find a demo task by its English title (content is defined in English and Arabic).
     */
    private function task(string $english, bool $required = true): ?Task
    {
        $index = collect(DemoContent::TASKS)->search(fn (array $row) => $row[0] === $english);
        if ($index === false) {
            if ($required) {
                throw new \LogicException("Unknown demo task: {$english}");
            }

            return null;
        }

        return $this->tasks[$index];
    }

    /**
     * Offset (in days) of the $n-th weekday after today, skipping $avoid offsets.
     *
     * @param  list<int>  $avoid
     */
    private function nextWeekday(int $n, array $avoid = []): int
    {
        $offset = 0;
        $found = 0;
        while ($found < $n) {
            $offset++;
            if ($this->today->addDays($offset)->isWeekday() && ! in_array($offset, $avoid, true)) {
                $found++;
            }
        }

        return $offset;
    }

    private function previousWeekday(int $offset): int
    {
        while (! $this->today->addDays($offset)->isWeekday()) {
            $offset--;
        }

        return $offset;
    }

    /**
     * A task that was being worked on around $date (for linking historical focus sessions).
     *
     * @param  Collection<int, Task>  $pool
     */
    private function taskActiveOn(Collection $pool, CarbonImmutable $date): ?Task
    {
        $candidates = $pool->filter(fn (Task $t) => $t->created_at <= $date->endOfDay() && ($t->completed_at === null || $t->completed_at >= $date->startOfDay()))->values();

        return $candidates->isEmpty() ? null : $candidates[mt_rand(0, $candidates->count() - 1)];
    }
}
