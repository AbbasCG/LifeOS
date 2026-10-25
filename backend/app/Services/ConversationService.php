<?php

namespace App\Services;

use App\Models\AssistantProposal;
use App\Models\Conversation;
use App\Models\ConversationMessage;
use App\Models\Goal;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;

/**
 * Multi-turn Copilot conversations on top of AssistantService.
 *
 * - History: earlier turns are passed to the provider as untrusted data (last few turns only) and used for
 *   deterministic follow-ups ("make them 90 minutes", "next week instead", "essentials only").
 * - Clarification: an ambiguous planning request is answered with a question and options; choosing one resumes the
 *   pending request with that slot filled.
 * - Approval guard: typing "yes, apply" never applies anything — changes are applied only through the proposal's
 *   Apply button, which re-validates them; agreeing in chat is never standing permission.
 * - Idempotency: a client id on each user message makes retries return the stored answer instead of running twice.
 */
class ConversationService
{
    public const HISTORY_TURNS = 6;

    /** Plan choices that switch moving flexible blocks on or off. */
    public const MOVE_CHOICES = ['moves:on', 'moves:off'];

    private const ALLOW_MOVES = '/(you can|it.?s ok to|go ahead and|allow|feel free to) mov|move (things|them|blocks) if needed|يمكنك (النقل|نقل)|انقل (ما يلزم|عند الحاجة)/u';

    public const PAYLOAD_KEYS = ['subtasks', 'tasks', 'items', 'proposal', 'plan', 'clarify', 'state', 'context', 'notice'];

    private const APPROVAL = '/^(?:(?:yes|yeah|yep|yup|ok|okay|sure|please|apply|applied|do it|go ahead|go|confirm|confirmed|approve|approved|accept|accepted|book|add|execute|run|them|it|all|that|this|the plan|the proposal|now|everything|'
        .'نعم|أجل|اجل|موافق|موافقة|أوافق|اوافق|طبق|طبّق|طبقها|طبّقها|نفذ|نفّذ|نفذها|نفّذها|تمام|حسنا|حسناً|أضفها|اضفها|احجزها|الخطة|كلها|الكل|الآن|من فضلك|لو سمحت)[\s,!.،؟?]*)+$/u';

    public function __construct(private AssistantService $assistant, private CopilotPlanner $planner, private AssistantActions $actions) {}

    /**
     * @return Collection<int, Conversation>
     */
    public function list(User $user, int $limit = 50): Collection
    {
        return Conversation::where('user_id', $user->id)->orderByDesc('last_message_at')->limit($limit)->get();
    }

    /**
     * The user's conversations whose title or messages contain the query (case-insensitive), newest first, each with
     * a short snippet of the first matching message.
     *
     * @return list<array<string, mixed>>
     */
    public function search(User $user, string $query, int $limit = 50): array
    {
        $needle = mb_strtolower(trim($query));
        $like = '%'.addcslashes($needle, '\\%_').'%';
        $conversations = Conversation::where('user_id', $user->id)
            ->where(fn ($q) => $q->whereRaw('lower(title) like ?', [$like])
                ->orWhereExists(fn ($m) => $m->selectRaw('1')->from('conversation_messages')->whereColumn('conversation_messages.conversation_id', 'conversations.id')->whereRaw('lower(content) like ?', [$like])))
            ->orderByDesc('last_message_at')->limit($limit)->get();
        $hits = ConversationMessage::whereIn('conversation_id', $conversations->pluck('id'))->whereRaw('lower(content) like ?', [$like])->orderBy('id')->get(['conversation_id', 'content'])->groupBy('conversation_id');

        return $conversations->map(function (Conversation $c) use ($hits, $needle) {
            $content = $hits->get($c->id)?->first()?->content;
            $snippet = null;
            if ($content !== null) {
                $at = max(0, (int) mb_strpos(mb_strtolower($content), $needle) - 40);
                $snippet = ($at > 0 ? '…' : '').trim(mb_substr(preg_replace('/\s+/u', ' ', $content) ?? '', $at, 140)).(mb_strlen($content) > $at + 140 ? '…' : '');
            }

            return $c->present() + ['match' => $snippet];
        })->all();
    }

    /**
     * One conversation as a Markdown document: every message, with plans (explanation, conflicts) and proposals (each
     * change and its current status). Only the user's own data; nothing is sent anywhere.
     */
    public function markdown(Conversation $conversation): string
    {
        $lines = ['# '.$conversation->title, '', '_'.$conversation->created_at?->toIso8601String().' · '.($conversation->language === 'ar' ? 'Arabic' : 'English').'_', ''];
        foreach ($this->messages($conversation) as $m) {
            $who = $m['role'] === 'user' ? 'You' : 'Copilot ('.(($m['provider'] ?? 'local') === 'local' ? 'rule-based' : 'AI · '.$m['provider']).')';
            $lines[] = "## {$who} — ".substr((string) $m['created_at'], 0, 16);
            $lines[] = '';
            $lines[] = (string) $m['content'];
            $lines[] = '';
            if (! empty($m['plan'])) {
                $lines[] = '**'.$m['plan']['title'].'**';
                foreach ($m['plan']['explanation'] ?? [] as $e) {
                    $lines[] = "- {$e}";
                }
                foreach ($m['plan']['conflicts'] ?? [] as $c) {
                    $lines[] = "- ⚠ {$c['title']}: {$c['detail']}";
                }
                $lines[] = '';
            }
            if (! empty($m['proposal'])) {
                $lines[] = '**Proposal** ('.$m['proposal']['status'].')';
                foreach ($m['proposal']['actions'] as $a) {
                    $when = isset($a['starts_at']) ? ' '.substr($a['starts_at'], 0, 16).(isset($a['from_starts_at']) ? ' (from '.substr($a['from_starts_at'], 0, 16).')' : '') : '';
                    $lines[] = "- {$a['type']}: {$a['title']}{$when}";
                }
                $lines[] = '';
            }
        }

        return implode("\n", $lines)."\n";
    }

    public function find(User $user, string $id): Conversation
    {
        return Conversation::where('user_id', $user->id)->whereKey($id)->firstOrFail();
    }

    /**
     * Messages with each proposal refreshed to its current state (applied, undone, expired or deleted since).
     *
     * @return list<array<string, mixed>>
     */
    public function messages(Conversation $conversation): array
    {
        $messages = $conversation->messages()->get();
        $ids = $messages->map(fn (ConversationMessage $m) => $m->payload['proposal']['id'] ?? null)->filter()->unique();
        $proposals = AssistantProposal::where('user_id', $conversation->user_id)->whereIn('id', $ids)->get()->keyBy('id');

        return $messages->map(function (ConversationMessage $m) use ($proposals) {
            $data = $m->present();
            if (isset($data['proposal']['id'])) {
                $data['proposal'] = $proposals->get($data['proposal']['id'])?->present();
            }

            return $data;
        })->all();
    }

    /**
     * Handle one user turn. $choice answers an earlier assistant message: a clarification option or a plan alternative.
     *
     * @param  array{type: string, message_id: int, value: string}|null  $choice
     * @param  (callable(string): void)|null  $progress
     * @return array{conversation: array<string, mixed>, user_message: array<string, mixed>, message: array<string, mixed>, replayed: bool}
     */
    public function send(User $user, ?string $conversationId, string $text, string $language, ?string $clientId = null, ?array $choice = null, ?callable $progress = null): array
    {
        $progress ??= fn (string $stage) => null;
        $ar = $language === 'ar';
        if ($clientId !== null && ($replay = $this->replay($user, $clientId))) {
            return $replay;
        }
        $conversation = $conversationId ? $this->find($user, $conversationId) : null;
        $previous = $conversation ? ConversationMessage::where('conversation_id', $conversation->id)->where('role', 'assistant')->orderByDesc('id')->first() : null;
        $answering = $choice && $conversation ? ConversationMessage::where('conversation_id', $conversation->id)->where('role', 'assistant')->whereKey($choice['message_id'])->first() : null;
        if ($choice && ! $answering) {
            abort(422, 'That message is not part of this conversation.');
        }
        if ($choice) {
            $this->assertOffered($answering, $choice);
        }
        $text = trim($text) !== '' ? trim($text) : $this->choiceLabel($answering, $choice, $ar);

        try {
            [$conversation, $userMessage] = DB::transaction(function () use ($user, $conversation, $text, $language, $clientId) {
                $conversation ??= Conversation::create(['user_id' => $user->id, 'title' => $this->title($text, $language), 'language' => $language, 'last_message_at' => now()]);
                $message = ConversationMessage::create(['conversation_id' => $conversation->id, 'user_id' => $user->id, 'role' => 'user', 'client_id' => $clientId, 'content' => $text]);

                return [$conversation, $message];
            });
        } catch (UniqueConstraintViolationException|QueryException $e) {
            if ($clientId !== null && ($replay = $this->replay($user, $clientId))) {
                return $replay;
            }
            throw $e;
        }
        $progress('received');

        $history = ConversationMessage::where('conversation_id', $conversation->id)->where('id', '<', $userMessage->id)->orderByDesc('id')->limit(self::HISTORY_TURNS)->get(['role', 'content', 'intent'])
            ->reverse()->map(fn (ConversationMessage $m) => ['role' => $m->role, 'content' => $m->content, 'intent' => $m->intent])->values()->all();
        $result = match (true) {
            $answering !== null => $this->answerChoice($user, $answering, $choice, $text, $language, $history, $progress),
            (bool) preg_match(self::APPROVAL, mb_strtolower(trim($text))) => $this->approvalGuard($conversation, $ar),
            default => $this->followUp($user, $previous, $text, $ar, $progress) ?? $this->assistant->respond($user, $text, $language, $history, $progress),
        };
        $progress('saving');

        $reply = DB::transaction(function () use ($user, $conversation, $result) {
            $payload = array_intersect_key($result, array_flip(self::PAYLOAD_KEYS));
            $reply = ConversationMessage::create(['conversation_id' => $conversation->id, 'user_id' => $user->id, 'role' => 'assistant', 'content' => (string) ($result['message'] ?? ''),
                'intent' => $result['intent'] ?? null, 'provider' => $result['provider'] ?? 'local', 'payload' => $payload]);
            if (isset($result['proposal']['id'])) {
                AssistantProposal::where('user_id', $user->id)->whereKey($result['proposal']['id'])->update(['conversation_id' => $conversation->id]);
            }
            $conversation->update(['last_message_at' => now()]);

            return $reply;
        });

        return ['conversation' => $conversation->fresh()->present(), 'user_message' => $userMessage->present(), 'message' => $reply->present(), 'replayed' => false];
    }

    /**
     * Start a conversation from something outside the chat (a proactive suggestion): the user's question and an
     * answer computed for it are stored like a normal turn, with any proposal linked to the conversation.
     *
     * @param  array<string, mixed>  $result  an assistant result (message, intent, provider, plan, proposal, …)
     * @return array{conversation: array<string, mixed>, user_message: array<string, mixed>, message: array<string, mixed>}
     */
    public function seed(User $user, string $text, string $language, array $result): array
    {
        return DB::transaction(function () use ($user, $text, $language, $result) {
            $conversation = Conversation::create(['user_id' => $user->id, 'title' => $this->title($text, $language), 'language' => $language, 'last_message_at' => now()]);
            $question = ConversationMessage::create(['conversation_id' => $conversation->id, 'user_id' => $user->id, 'role' => 'user', 'content' => $text]);
            $reply = ConversationMessage::create(['conversation_id' => $conversation->id, 'user_id' => $user->id, 'role' => 'assistant', 'content' => (string) ($result['message'] ?? ''),
                'intent' => $result['intent'] ?? null, 'provider' => $result['provider'] ?? 'local', 'payload' => array_intersect_key($result, array_flip(self::PAYLOAD_KEYS))]);
            if (isset($result['proposal']['id'])) {
                AssistantProposal::where('user_id', $user->id)->whereKey($result['proposal']['id'])->update(['conversation_id' => $conversation->id]);
            }

            return ['conversation' => $conversation->present(), 'user_message' => $question->present(), 'message' => $reply->present()];
        });
    }

    /**
     * Prompt suggestions: the defaults, or — only with conversation personalization switched on — the kinds of request
     * this user makes most often (counted from their own conversations since the last reset), first.
     *
     * @return list<string>
     */
    public function suggestions(User $user, string $language): array
    {
        $prompts = self::PROMPTS[$language === 'ar' ? 'ar' : 'en'];
        if (! IntelligenceSettings::feature($user, 'conversation_personalization')) {
            return array_values($prompts);
        }
        $since = IntelligenceSettings::for($user)['conversation_reset_at'] ?? null;
        $top = ConversationMessage::where('user_id', $user->id)->where('role', 'assistant')->whereIn('intent', array_keys($prompts))
            ->when($since, fn ($q) => $q->where('created_at', '>', CarbonImmutable::parse($since)))
            ->select('intent', DB::raw('count(*) as uses'))->groupBy('intent')->orderByDesc('uses')->limit(3)->pluck('intent')->all();

        return array_values(array_unique(array_merge(array_map(fn ($i) => $prompts[$i], $top), array_values($prompts))));
    }

    /**
     * Delete conversations whose last message is older than the user's AI retention period.
     */
    public function prune(User $user): int
    {
        $days = (int) IntelligenceSettings::for($user)['retention_days'];

        return Conversation::where('user_id', $user->id)->where('last_message_at', '<', now()->subDays($days))->delete();
    }

    /** @var array<string, array<string, string>> */
    public const PROMPTS = [
        'en' => ['plan_week' => 'Plan my next week around my meetings', 'prioritize' => 'Prioritize studying and my projects', 'focus_blocks' => 'Find three focus blocks without moving fixed appointments',
            'reorganize_day' => 'Reorganize today after an interruption', 'plan' => 'What should I focus on today?', 'conflicts' => 'Do I have any conflicts?', 'triage' => 'Reschedule my overdue tasks', 'reflection' => 'Help me reflect on my week'],
        'ar' => ['plan_week' => 'خطط أسبوعي القادم حول اجتماعاتي', 'prioritize' => 'أعطِ الأولوية للدراسة ومشاريعي', 'focus_blocks' => 'اعثر على ثلاث فترات تركيز دون نقل المواعيد الثابتة',
            'reorganize_day' => 'أعد تنظيم يومي بعد مقاطعة', 'plan' => 'بماذا أبدأ اليوم؟', 'conflicts' => 'هل لدي تعارضات؟', 'triage' => 'أعد جدولة المهام المتأخرة', 'reflection' => 'ساعدني على التأمل في أسبوعي'],
    ];

    /**
     * @return array{conversation: array<string, mixed>, user_message: array<string, mixed>, message: array<string, mixed>, replayed: bool}|null
     */
    private function replay(User $user, string $clientId): ?array
    {
        $original = ConversationMessage::where('user_id', $user->id)->where('client_id', $clientId)->first();
        if (! $original) {
            return null;
        }
        $reply = ConversationMessage::where('conversation_id', $original->conversation_id)->where('role', 'assistant')->where('id', '>', $original->id)->orderBy('id')->first();
        if (! $reply) {
            throw new ConflictHttpException('This message is still being answered.');
        }

        return ['conversation' => Conversation::findOrFail($original->conversation_id)->present(), 'user_message' => $original->present(), 'message' => $reply->present(), 'replayed' => true];
    }

    /**
     * @param  array{type: string, message_id: int, value: string}  $choice
     * @param  list<array{role: string, content: string}>  $history
     * @param  callable(string): void  $progress
     * @return array<string, mixed>
     */
    private function answerChoice(User $user, ConversationMessage $answering, array $choice, string $text, string $language, array $history, callable $progress): array
    {
        $ar = $language === 'ar';
        $state = $answering->payload['state'] ?? [];
        $intent = $state['intent'] ?? null;
        if ($choice['type'] === 'option' && $intent === 'goal_review') {
            // A goal picked from the monthly overview: its full review for that month and a proposed next step.
            $goal = Goal::where('user_id', $user->id)->findOrFail((int) $choice['value']);
            $progress('planning');

            return app(GoalReviewService::class)->reply($user, $goal, $ar, (bool) ($state['slots']['previous_month'] ?? false));
        }
        if ($choice['type'] === 'option') {
            if (! in_array($intent, CopilotPlanner::INTENTS, true)) {
                // A provider's free-text question: the chosen answer continues the conversation as a normal message.
                return $this->assistant->respond($user, $text, $language, $history, $progress);
            }
            $slots = $state['slots'] ?? [];
            match ($state['awaiting'] ?? null) {
                'priorities' => $slots['priorities'] = [$choice['value']],
                'interruption' => $slots['interruption'] = str_starts_with($choice['value'], 'lost:') ? ['lost_minutes' => (int) substr($choice['value'], 5)] : [],
                'template' => $slots['template_id'] = (int) $choice['value'],
                default => null,
            };
            $slots['ask_interruption'] = false;
        } else {
            $slots = match (true) {
                in_array($choice['value'], self::MOVE_CHOICES, true) => array_merge($state['slots'] ?? [], ['moves' => $choice['value'] === 'moves:on', 'ask_interruption' => false]),
                str_starts_with($choice['value'], 'area:') => array_merge($state['slots'] ?? [], ['area' => substr($choice['value'], 5)]),
                str_starts_with($choice['value'], 'week:') => array_merge($state['slots'] ?? [], ['next_week' => $choice['value'] === 'week:next']),
                default => array_merge($state['slots'] ?? [], ['alternative' => $choice['value'], 'variant' => $choice['value'], 'ask_interruption' => false]),
            };
            $this->learn($user, $intent, $choice['value'], (array) ($state['learning_context'] ?? []));
            $this->dismissPrevious($user, $answering);
        }
        $progress('planning');

        return $this->planned($user, $intent, $slots, $ar, $answering->provider);
    }

    /**
     * A choice must be one of the options or plan alternatives that message actually offered.
     *
     * @param  array{type: string, message_id: int, value: string}  $choice
     */
    private function assertOffered(ConversationMessage $answering, array $choice): void
    {
        $offered = $choice['type'] === 'option'
            ? collect($answering->payload['clarify']['options'] ?? [])->pluck('value')
            : (in_array($answering->payload['state']['intent'] ?? null, CopilotPlanner::INTENTS, true)
                ? collect($answering->payload['plan']['alternatives'] ?? [])->pluck('key')->merge(isset($answering->payload['plan']['moves']) ? self::MOVE_CHOICES : [])
                : collect());
        if (! $offered->contains($choice['value'])) {
            abort(422, $choice['type'] === 'option' ? 'That option was not offered.' : 'That alternative was not offered.');
        }
    }

    /**
     * Deterministic follow-up on the last plan: changed length, count, week, day, priorities or version. Returns null
     * when the message is a new request.
     *
     * @param  callable(string): void  $progress
     * @return array<string, mixed>|null
     */
    private function followUp(User $user, ?ConversationMessage $previous, string $text, bool $ar, callable $progress): ?array
    {
        $state = $previous?->payload['state'] ?? null;
        $intent = $state['intent'] ?? null;
        if (! in_array($intent, CopilotPlanner::INTENTS, true) || mb_strlen($text) > 100 || ! in_array($this->assistant->intentOf($text), ['help', 'plan', 'review'], true)) {
            return null;
        }
        $lower = mb_strtolower($text);
        $slots = $state['slots'] ?? [];
        $changes = [];
        $alternatives = [
            'essentials' => '/essential|only the important|just the important|الأساسي|الضروري/u', 'balanced' => '/balanced|everything|all of it|متوازن|كل شيء|الكل/u',
            'short' => '/shorter|45/u', 'long' => '/longer|90/u', 'deep' => '/\bdeep\b|عميق/u', 'light' => '/light|lighter|خفيف/u', 'deadlines' => '/deadline|المواعيد/u',
        ];
        $valid = match ($intent) {
            'plan_week', 'prioritize' => ['essentials', 'balanced'], 'focus_blocks' => [], 'reorganize_day' => ['balanced', 'deep', 'light', 'deadlines'],
        };
        foreach ($valid as $key) {
            if (preg_match($alternatives[$key], $lower)) {
                $changes['alternative'] = $key;
                break;
            }
        }
        if ($intent === 'focus_blocks') {
            $normalized = strtr($lower, ['٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9']);
            if (($minutes = CopilotPlanner::minutesIn($normalized)) !== null) {
                $changes['minutes'] = max(30, min(180, $minutes));
                $changes['alternative'] = 'default';
            } elseif (preg_match('/shorter|أقصر|اقصر/u', $lower)) {
                $changes['alternative'] = 'short';
            } elseif (preg_match('/longer|أطول|اطول/u', $lower)) {
                $changes['alternative'] = 'long';
            }
            if (($count = CopilotPlanner::countIn($normalized)) !== null) {
                $changes['count'] = $count;
            }
            if (($area = CopilotPlanner::areaIn($lower)) !== null && $area !== ($slots['area'] ?? null)) {
                $changes['area'] = $area;
            }
            if (preg_match('/tomorrow|غدا|غداً|الغد/u', $lower)) {
                $changes['within'] = 'tomorrow';
            } elseif (preg_match('/this week|the week|هذا الأسبوع|الأسبوع/u', $lower)) {
                $changes['within'] = 'week';
            } elseif (preg_match('/\btoday\b|اليوم/u', $lower)) {
                $changes['within'] = 'today';
            }
        }
        if (in_array($intent, ['plan_week', 'prioritize', 'use_template'], true)) {
            if (preg_match('/next week|الأسبوع القادم|الاسبوع القادم|الأسبوع المقبل/u', $lower)) {
                $changes['next_week'] = true;
            } elseif (preg_match('/this week|هذا الأسبوع|هذا الاسبوع/u', $lower)) {
                $changes['next_week'] = false;
            }
            if (($priorities = CopilotPlanner::prioritiesIn($lower)) !== [] && ! isset($changes['alternative'])) {
                $changes['priorities'] = $priorities;
            }
        }
        if ($intent !== 'focus_blocks' && CopilotPlanner::keepsInPlace($lower)) {
            $changes['moves'] = false;
        } elseif ($intent !== 'focus_blocks' && preg_match(self::ALLOW_MOVES, $lower)) {
            $changes['moves'] = true;
        }
        if ($intent === 'reorganize_day' && preg_match('/tomorrow|غدا|غداً|الغد/u', $lower)) {
            $changes['date'] = CarbonImmutable::now($user->timezone())->addDay()->toDateString();
        }
        if ($changes === []) {
            return null;
        }
        $progress('planning');
        $this->dismissPrevious($user, $previous);
        if (isset($changes['alternative'])) {
            $this->learn($user, $intent, $changes['alternative'], (array) ($state['learning_context'] ?? []));
        }
        if (isset($changes['moves'])) {
            $this->learn($user, $intent, $changes['moves'] ? 'moves:on' : 'moves:off', (array) ($state['learning_context'] ?? []));
        }

        return $this->planned($user, $intent, array_merge($slots, $changes, ['ask_interruption' => false]), $ar, $previous->provider === 'local' ? 'local' : $previous->provider);
    }

    /**
     * @param  array<string, mixed>  $slots
     * @return array<string, mixed>
     */
    private function planned(User $user, string $intent, array $slots, bool $ar, ?string $provider): array
    {
        if ($intent === 'reorganize_day') {
            $slots['alternative'] ??= $slots['variant'] ?? null;
        }
        $result = $this->planner->run($user, $intent, $slots, $ar, $provider ?: 'local');
        $sources = AssistantService::LOCAL_SOURCES[$intent] ?? ['tasks'];

        return $result + ['provider' => $provider ?: 'local', 'intent' => $intent, 'context' => ['shared' => false, 'sources' => array_map(fn ($s) => ['source' => $s], $sources)]];
    }

    /**
     * Count a plan choice the user made, in the situation the plan was made in (opt-in plan learning; a no-op when
     * learning is off).
     *
     * @param  array{day?: string, load?: string}  $context
     */
    private function learn(User $user, string $intent, string $choice, array $context = []): void
    {
        match (true) {
            in_array($choice, self::MOVE_CHOICES, true) => PlanLearning::record($user, 'moves', $choice === 'moves:on' ? 'on' : 'off', $context),
            in_array($intent, ['plan_week', 'prioritize'], true) => PlanLearning::record($user, 'week_version', $choice, $context),
            $intent === 'focus_blocks' => PlanLearning::record($user, 'focus_length', $choice, $context),
            $intent === 'reorganize_day' => PlanLearning::record($user, 'day_strategy', $choice, $context),
            default => null,
        };
    }

    /**
     * Learn from a plan the user applied: the version they applied counts as their choice.
     */
    public function learnFromApplied(User $user, AssistantProposal $proposal): void
    {
        if (! PlanLearning::enabled($user) || ! $proposal->conversation_id) {
            return;
        }
        $message = ConversationMessage::where('conversation_id', $proposal->conversation_id)->where('user_id', $user->id)->where('role', 'assistant')->orderByDesc('id')->get()
            ->first(fn (ConversationMessage $m) => ($m->payload['proposal']['id'] ?? null) === $proposal->id);
        if ($message && isset($message->payload['state'])) {
            PlanLearning::recordState($user, $message->payload['state']);
        }
    }

    /**
     * A replaced plan's still-pending proposal is withdrawn, so only the current version can be applied.
     */
    private function dismissPrevious(User $user, ?ConversationMessage $message): void
    {
        $id = $message?->payload['proposal']['id'] ?? null;
        $proposal = $id ? AssistantProposal::where('user_id', $user->id)->whereKey($id)->where('status', 'pending')->first() : null;
        if ($proposal) {
            $this->actions->dismiss($proposal);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function approvalGuard(Conversation $conversation, bool $ar): array
    {
        $pending = AssistantProposal::where('user_id', $conversation->user_id)->where('conversation_id', $conversation->id)->where('status', 'pending')->where('expires_at', '>', now())->exists();
        $message = match (true) {
            $pending && $ar => 'لا أطبّق التغييرات من خلال الدردشة. راجع الاقتراح أعلاه، واختر ما تريده، ثم اضغط «تطبيق» — سيُتحقق من كل تغيير قبل حفظه، ويمكنك التراجع خلال ٢٤ ساعة.',
            $pending => 'I don’t apply changes from chat. Review the proposal above, choose what you want, then press Apply — each change is re-checked before it’s saved, and you can undo it for 24 hours.',
            $ar => 'لا يوجد اقتراح بانتظار موافقتك في هذه المحادثة. اطلب خطة أولاً، وستراجعها قبل تطبيق أي شيء.',
            default => 'There’s no proposal waiting for your approval in this conversation. Ask for a plan first; you’ll review it before anything is applied.',
        };

        return ['message' => $message, 'intent' => 'approval_guard', 'provider' => 'local', 'context' => ['shared' => false, 'sources' => []]];
    }

    /**
     * @param  array{type: string, message_id: int, value: string}|null  $choice
     */
    private function choiceLabel(?ConversationMessage $answering, ?array $choice, bool $ar): string
    {
        if (! $answering || ! $choice) {
            abort(422, 'Write a message.');
        }
        if (in_array($choice['value'], self::MOVE_CHOICES, true)) {
            return $choice['value'] === 'moves:off' ? ($ar ? 'أبقِ كل شيء في مكانه' : 'Keep everything in place') : ($ar ? 'انقل الفترات المرنة عند الحاجة' : 'Move flexible blocks if needed');
        }
        $list = $choice['type'] === 'option' ? ($answering->payload['clarify']['options'] ?? []) : ($answering->payload['plan']['alternatives'] ?? []);
        $match = collect($list)->first(fn ($o) => ($o['value'] ?? $o['key'] ?? null) === $choice['value']);
        $label = $match['label'] ?? $choice['value'];

        return CopilotContext::clean(is_array($label) ? ($label[$ar ? 'ar' : 'en'] ?? $choice['value']) : (string) $label);
    }

    private function title(string $text, string $language): string
    {
        $title = mb_substr(CopilotContext::clean($text), 0, 60);

        return $title !== '' ? $title : ($language === 'ar' ? 'محادثة جديدة' : 'New conversation');
    }
}
