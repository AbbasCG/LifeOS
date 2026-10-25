<?php

namespace App\Http\Controllers;

use App\Integrations\Ai\AiProviders;
use App\Models\AssistantProposal;
use App\Models\AuditLog;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Recommendation;
use App\Services\AssistantService;
use App\Services\AuditLogger;
use App\Services\ConversationService;
use App\Services\IntelligenceSettings;
use App\Services\MorningIntelligence;
use App\Services\PlanLearning;
use App\Services\RecommendationService;
use App\Services\WeeklyIntelligence;
use App\Services\WeeklyReviewService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Proactive personal AI: the morning briefing, recommendations, weekly narrative and the AI Control Center.
 * Every endpoint reads or changes only the signed-in user's own data.
 */
class IntelligenceController extends Controller
{
    /** Audit actions shown in the AI activity history. */
    public const ACTIVITY = ['ai_action_executed', 'ai_action_undone', 'recommendation_acted', 'recommendation_dismissed', 'ai_settings_changed', 'ai_personalization_reset', 'ai_data_deleted', 'plan_learning_reset', 'recommendation_discussed', 'conversation_deleted', 'conversation_exported', 'plan_template_saved',
        'calendar_write', 'calendar_write_failed', 'calendar_write_granted', 'calendar_write_enabled', 'calendar_write_disabled'];

    public function __construct(private RecommendationService $recommendations, private AuditLogger $audit) {}

    public function briefing(Request $request, MorningIntelligence $morning): JsonResponse
    {
        return response()->json($morning->briefing($request->user()));
    }

    public function recommendations(Request $request): JsonResponse
    {
        $user = $request->user();

        return response()->json(['enabled' => $this->recommendations->enabled($user), 'quiet_types' => $this->recommendations->quietTypes($user),
            'data' => $this->recommendations->current($user)->map->present()->values()]);
    }

    public function dismiss(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['snooze_days' => ['nullable', 'integer', Rule::in(RecommendationService::SNOOZE_DAYS)]]);

        return response()->json($this->recommendations->dismiss($request->user(), $this->find($request, $id), $data['snooze_days'] ?? null, $request)->present());
    }

    public function feedback(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['useful' => 'required|boolean']);

        return response()->json($this->recommendations->feedback($request->user(), $this->find($request, $id), (bool) $data['useful'])->present());
    }

    /**
     * Open a suggestion as a Copilot conversation (any change in it is a pending proposal).
     */
    public function discuss(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['language' => 'required|in:en,ar']);

        return response()->json($this->recommendations->discuss($request->user(), $this->find($request, $id), $data['language'], $request), 201);
    }

    public function act(Request $request, int $id): JsonResponse
    {
        return response()->json($this->recommendations->act($request->user(), $this->find($request, $id), $request)->present(), 201);
    }

    public function settings(Request $request, AssistantService $assistant): JsonResponse
    {
        $user = $request->user();
        $prefs = $user->preferences();
        $provider = $assistant->provider($user);
        $active = app(AiProviders::class)->active();

        return response()->json([
            'settings' => IntelligenceSettings::for($user),
            'options' => ['features' => IntelligenceSettings::FEATURES, 'sources' => IntelligenceSettings::SOURCES, 'frequencies' => IntelligenceSettings::FREQUENCIES,
                'retention_days' => IntelligenceSettings::RETENTION, 'strategies' => IntelligenceSettings::STRATEGIES],
            'external_ai' => ['allowed' => (bool) ($prefs['assistant_external'] ?? true), 'connected_data' => (bool) ($prefs['ai_connected_data'] ?? false),
                'provider' => $active ? ['label' => $active->label(), 'model' => $active->model()] : null, 'in_use' => $provider !== null],
            'counts' => ['recommendations' => Recommendation::where('user_id', $user->id)->count(), 'feedback' => Recommendation::where('user_id', $user->id)->whereNotNull('feedback')->count(),
                'proposals' => AssistantProposal::where('user_id', $user->id)->count(), 'conversations' => Conversation::where('user_id', $user->id)->count(),
                'conversation_messages' => ConversationMessage::where('user_id', $user->id)->count()],
            'learning' => ['thresholds' => ['count' => PlanLearning::MIN_COUNT, 'share' => PlanLearning::MIN_SHARE], 'dimensions' => PlanLearning::summary($user)],
        ]);
    }

    public function saveSettings(Request $request): JsonResponse
    {
        $flags = fn (array $keys, string $prefix) => collect($keys)->mapWithKeys(fn ($k) => ["{$prefix}.{$k}" => 'sometimes|boolean'])->all();
        $data = $request->validate([
            'enabled' => 'sometimes|boolean',
            'features' => 'sometimes|array:'.implode(',', IntelligenceSettings::FEATURES),
            'sources' => 'sometimes|array:'.implode(',', IntelligenceSettings::SOURCES),
            'frequency' => ['sometimes', Rule::in(IntelligenceSettings::FREQUENCIES)],
            'personalization' => 'sometimes|boolean',
            'retention_days' => ['sometimes', 'integer', Rule::in(IntelligenceSettings::RETENTION)],
            'planning_strategy' => ['sometimes', 'nullable', Rule::in(IntelligenceSettings::STRATEGIES)],
        ] + $flags(IntelligenceSettings::FEATURES, 'features') + $flags(IntelligenceSettings::SOURCES, 'sources'));
        $saved = IntelligenceSettings::save($request->user(), $data);
        $this->audit->log($request->user(), 'ai_settings_changed', $request, ['changed' => array_keys($data)]);
        if (array_key_exists('retention_days', $data)) {
            $this->recommendations->prune($request->user());
            app(ConversationService::class)->prune($request->user());
        }

        return response()->json(['settings' => $saved]);
    }

    /**
     * What the AI did and suggested: proposals, recommendation history and AI-related audit entries.
     */
    public function activity(Request $request): JsonResponse
    {
        $user = $request->user();

        return response()->json([
            'proposals' => AssistantProposal::where('user_id', $user->id)->latest()->limit(30)->get()->map(fn (AssistantProposal $p) => [
                'id' => $p->id, 'kind' => $p->kind, 'provider' => $p->provider, 'status' => $p->present()['status'], 'summary' => $p->summary, 'actions' => count($p->actions ?? []),
                'created_at' => $p->created_at?->toIso8601String(), 'applied_at' => $p->applied_at?->toIso8601String(),
            ]),
            'recommendations' => Recommendation::where('user_id', $user->id)->latest('updated_at')->limit(30)->get()->map->present(),
            'events' => AuditLog::where('user_id', $user->id)->whereIn('action', self::ACTIVITY)->latest('id')->limit(50)->get()->map(fn (AuditLog $l) => [
                'action' => $l->action, 'at' => $l->created_at?->toIso8601String(), 'meta' => array_intersect_key($l->meta ?? [], array_flip(['kind', 'type', 'op', 'provider', 'reversed', 'kept', 'actions', 'reason', 'changed', 'deleted'])),
            ]),
        ]);
    }

    /**
     * Forget what personalization learned: recommendation feedback is cleared and conversation personalization starts
     * over from now (the recommendations and conversations themselves stay).
     */
    public function resetPersonalization(Request $request): JsonResponse
    {
        $cleared = Recommendation::where('user_id', $request->user()->id)->whereNotNull('feedback')->update(['feedback' => null, 'feedback_at' => null]);
        IntelligenceSettings::save($request->user(), ['conversation_reset_at' => now()->toIso8601String()]);
        $cleared += PlanLearning::reset($request->user());
        $this->audit->log($request->user(), 'ai_personalization_reset', $request, ['deleted' => $cleared]);

        return response()->json(['cleared' => $cleared]);
    }

    /**
     * Delete stored AI data: recommendations (with feedback), Copilot proposals and conversations. Tasks, events and other work data are
     * untouched; the audit trail of applied changes is kept for security.
     */
    public function deleteData(Request $request): JsonResponse
    {
        $user = $request->user();
        $deleted = ['recommendations' => Recommendation::where('user_id', $user->id)->delete(), 'proposals' => AssistantProposal::where('user_id', $user->id)->delete(),
            'conversations' => Conversation::where('user_id', $user->id)->delete(), 'plan_learning' => PlanLearning::reset($user)];
        $this->audit->log($user, 'ai_data_deleted', $request, ['deleted' => array_sum($deleted)]);

        return response()->json(['deleted' => $deleted]);
    }

    /**
     * Forget learned plan preferences only (the plan-learning switch stays as it is).
     */
    public function forgetLearning(Request $request): JsonResponse
    {
        $cleared = PlanLearning::reset($request->user());
        $this->audit->log($request->user(), 'plan_learning_reset', $request, ['deleted' => $cleared]);

        return response()->json(['cleared' => $cleared]);
    }

    public function narrative(Request $request, string $week, WeeklyReviewService $reviews, WeeklyIntelligence $weekly): JsonResponse
    {
        $user = $request->user();
        $start = $reviews->weekStart($user, $week);
        $intelligence = $weekly->build($user, $start, $reviews->build($user, $start));
        if (! ($intelligence['enabled'] ?? false)) {
            return response()->json(['kind' => 'rules', 'text' => '', 'fallback_reason' => 'disabled']);
        }

        return response()->json($weekly->narrative($user, $intelligence, ($user->preferences()['language'] ?? 'en') === 'ar'));
    }

    private function find(Request $request, int $id): Recommendation
    {
        return Recommendation::where('user_id', $request->user()->id)->findOrFail($id);
    }
}
