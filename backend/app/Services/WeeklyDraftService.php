<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\PlanTemplate;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;

/**
 * Opt-in weekly plan drafts. On the weekday and time the user picks, Copilot prepares next week's plan — from a saved
 * template, or with the week planner and the user's learned preferences — as a Copilot conversation holding a pending
 * proposal, and sends one "planning" notification. Nothing is written to tasks or calendars: the draft only changes
 * anything once the user approves it, and it expires at the end of the week's first day.
 */
class WeeklyDraftService
{
    public const DEFAULTS = ['enabled' => false, 'weekday' => 0, 'time' => '18:00', 'template_id' => null];

    /** Settings stored next to the AI settings (user_settings.preferences.weekly_draft). */
    private const KEY = 'weekly_draft';

    public function __construct(private CopilotPlanner $planner, private ConversationService $conversations, private Notifier $notifier, private AuditLogger $audit) {}

    /**
     * @return array{enabled: bool, weekday: int, time: string, template_id: int|null, last_week: string|null}
     */
    public static function settings(User $user): array
    {
        $stored = (array) ($user->preferences()[self::KEY] ?? []);

        return ['enabled' => (bool) ($stored['enabled'] ?? false), 'weekday' => (int) ($stored['weekday'] ?? 0), 'time' => (string) ($stored['time'] ?? '18:00'),
            'template_id' => isset($stored['template_id']) ? (int) $stored['template_id'] : null, 'last_week' => $stored['last_week'] ?? null];
    }

    /**
     * @param  array{enabled?: bool, weekday?: int, time?: string, template_id?: int|null, last_week?: string|null}  $changes  already validated
     * @return array{enabled: bool, weekday: int, time: string, template_id: int|null, last_week: string|null}
     */
    public static function save(User $user, array $changes): array
    {
        $setting = UserSetting::firstOrCreate(['user_id' => $user->id], ['preferences' => []]);
        $preferences = $setting->preferences ?? [];
        $preferences[self::KEY] = array_merge(self::settings($user), $changes);
        $setting->update(['preferences' => $preferences]);

        return self::settings($user->fresh());
    }

    /**
     * The Monday of the week a draft prepared now would plan (always the coming week).
     */
    public static function targetWeek(User $user): CarbonImmutable
    {
        return CarbonImmutable::now($user->timezone())->startOfWeek(CarbonImmutable::MONDAY)->addWeek();
    }

    /**
     * Whether a scheduled draft is due for this user now: drafts are on (and AI features are), it is the chosen
     * weekday at or after the chosen time, and no draft was prepared for the coming week yet.
     */
    public function due(User $user): bool
    {
        $s = self::settings($user);
        if (! $s['enabled'] || ! IntelligenceSettings::for($user)['enabled']) {
            return false;
        }
        $now = CarbonImmutable::now($user->timezone());

        return $now->dayOfWeek === $s['weekday'] && $now->format('H:i') >= $s['time'] && $s['last_week'] !== self::targetWeek($user)->toDateString();
    }

    /**
     * Prepare a draft for the coming week now: a new Copilot conversation with a pending proposal.
     *
     * @param  bool  $scheduled  true when prepared by the schedule (it then notifies and is remembered for the week)
     * @return array<string, mixed> the seeded conversation, its question and the reply
     */
    public function prepare(User $user, string $language, bool $scheduled = false, ?Request $request = null): array
    {
        $ar = $language === 'ar';
        $monday = self::targetWeek($user);
        $s = self::settings($user);
        $template = $s['template_id'] ? PlanTemplate::where('user_id', $user->id)->find($s['template_id']) : null;
        $range = $monday->locale($ar ? 'ar' : 'en')->translatedFormat('j M').' – '.$monday->addDays(6)->locale($ar ? 'ar' : 'en')->translatedFormat('j M');
        $text = $ar ? "مسودة خطة الأسبوع القادم ({$range})" : "Draft next week’s plan ({$range})";
        $intent = $template ? 'use_template' : 'plan_week';
        $result = $this->planner->run($user, $intent, $template ? ['template_id' => $template->id, 'next_week' => true, 'message' => ''] : ['next_week' => true], $ar, 'local');
        $result += ['intent' => $intent, 'provider' => 'local', 'context' => ['shared' => false, 'sources' => array_map(fn ($source) => ['source' => $source], AssistantService::LOCAL_SOURCES[$intent] ?? ['tasks'])]];
        $how = match (true) {
            $template !== null => $ar ? "من قالبك «{$template->name}»" : "from your template “{$template->name}”",
            $s['template_id'] !== null => $ar ? 'بمخطط الأسبوع لأن القالب المختار لم يعد موجوداً' : 'with the week planner, because the chosen template no longer exists',
            default => $ar ? 'بمخطط الأسبوع وتفضيلاتك' : 'with the week planner and your preferences',
        };
        $when = $scheduled ? ($ar ? 'حسب جدولك' : 'on your schedule') : ($ar ? 'بطلبك' : 'at your request');
        $result['notice'] = $ar ? "مسودة أُعدّت {$when}، {$how}. لا يتغير شيء حتى توافق عليها."
            : "Draft prepared {$when}, {$how}. Nothing changes until you approve it.";

        // A draft stays open until the end of the planned week's first day (proposals otherwise last 24 hours).
        if (isset($result['proposal']['id'])) {
            $expires = $monday->endOfDay()->utc();
            AssistantProposal::where('user_id', $user->id)->whereKey($result['proposal']['id'])->where('expires_at', '<', $expires)->update(['expires_at' => $expires]);
            $result['proposal'] = AssistantProposal::find($result['proposal']['id'])->present();
        }
        $seeded = $this->conversations->seed($user, $text, $language, $result);
        $hasProposal = isset($result['proposal']['id']);
        if ($scheduled) {
            self::save($user, ['last_week' => $monday->toDateString()]);
            $this->notifier->send($user, 'planning', "weekly-draft:{$user->id}:{$monday->toDateString()}",
                $hasProposal ? ($ar ? 'مسودة خطة الأسبوع القادم جاهزة' : 'Next week’s plan draft is ready') : ($ar ? 'تعذّر إعداد مسودة الأسبوع القادم' : 'No draft for next week'),
                ['body' => $hasProposal ? ($ar ? 'راجعها ووافق على ما يناسبك. لا يتغير شيء قبل موافقتك.' : 'Review it and approve what fits. Nothing changes until you do.')
                    : (string) ($result['message'] ?? ''), 'link' => '/assistant?c='.$seeded['conversation']['id'], 'kind' => 'weekly_draft']);
        }
        $this->audit->log($user, 'weekly_draft_prepared', $request, ['week' => $monday->toDateString(), 'scheduled' => $scheduled, 'source' => $template ? 'template' : 'planner', 'proposal' => $hasProposal]);

        return $seeded;
    }
}
