<?php

namespace App\Http\Controllers;

use App\Models\AssistantProposal;
use App\Models\Conversation;
use App\Models\PlanTemplate;
use App\Services\AuditLogger;
use App\Services\ConversationService;
use App\Services\CopilotPlanner;
use App\Services\IntelligenceSettings;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

/**
 * Copilot conversations. Messages can be answered as JSON or as a server-sent event stream that reports the real
 * processing stages before the final, validated answer (model output is never shown before it is validated).
 */
class CopilotController extends Controller
{
    public function __construct(private ConversationService $conversations, private AuditLogger $audit) {}

    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $language = $request->query('language') === 'ar' ? 'ar' : 'en';

        $query = trim((string) $request->query('q', ''));
        if (mb_strlen($query) > 100) {
            abort(422, 'Search for at most 100 characters.');
        }

        return response()->json([
            'conversations' => $query !== '' ? $this->conversations->search($user, $query) : $this->conversations->list($user)->map->present()->values(),
            'suggestions' => $this->conversations->suggestions($user, $language),
            'personalization' => IntelligenceSettings::feature($user, 'conversation_personalization'),
            'retention_days' => IntelligenceSettings::for($user)['retention_days'],
        ]);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $conversation = $this->conversations->find($request->user(), $id);

        return response()->json(['conversation' => $conversation->present(), 'messages' => $this->conversations->messages($conversation)]);
    }

    /**
     * Download one conversation as Markdown (default) or JSON.
     */
    public function export(Request $request, string $id): Response
    {
        $format = $request->query('format', 'md');
        if (! in_array($format, ['md', 'json'], true)) {
            abort(422, 'Choose md or json.');
        }
        $conversation = $this->conversations->find($request->user(), $id);
        $this->audit->log($request->user(), 'conversation_exported', $request, ['type' => $format]);
        $name = 'lifeos-conversation-'.$conversation->created_at?->format('Y-m-d').'-'.substr($conversation->id, 0, 8).'.'.$format;
        $body = $format === 'json'
            ? json_encode(['conversation' => $conversation->present(), 'messages' => $this->conversations->messages($conversation)], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            : $this->conversations->markdown($conversation);

        return response($body, 200, ['Content-Type' => ($format === 'json' ? 'application/json' : 'text/markdown').'; charset=utf-8', 'Content-Disposition' => 'attachment; filename="'.$name.'"', 'X-Content-Type-Options' => 'nosniff']);
    }

    public function templates(Request $request): JsonResponse
    {
        return response()->json(['templates' => PlanTemplate::where('user_id', $request->user()->id)->latest('updated_at')->limit(50)->get()->map->present()->values()]);
    }

    /**
     * Save the new blocks of one of the user's Copilot proposals as a week template.
     */
    public function saveTemplate(Request $request, CopilotPlanner $planner): JsonResponse
    {
        $data = $request->validate(['proposal_id' => 'required|uuid', 'name' => 'required|string|max:80', 'action_ids' => 'sometimes|array|max:60', 'action_ids.*' => 'string|max:10']);
        $user = $request->user();
        if (PlanTemplate::where('user_id', $user->id)->count() >= 50) {
            abort(422, 'You can keep up to 50 templates. Delete one first.');
        }
        $proposal = AssistantProposal::where('user_id', $user->id)->findOrFail($data['proposal_id']);
        $template = $planner->saveTemplate($user, $proposal, $data['name'], $data['action_ids'] ?? []);
        $this->audit->log($user, 'plan_template_saved', $request, ['actions' => count($template->blocks)]);

        return response()->json(['template' => $template->present()], 201);
    }

    public function renameTemplate(Request $request, int $id): JsonResponse
    {
        $data = $request->validate(['name' => 'required|string|max:80']);
        $template = PlanTemplate::where('user_id', $request->user()->id)->findOrFail($id);
        $template->update(['name' => trim($data['name'])]);

        return response()->json(['template' => $template->present()]);
    }

    public function destroyTemplate(Request $request, int $id): JsonResponse
    {
        PlanTemplate::where('user_id', $request->user()->id)->findOrFail($id)->delete();

        return response()->json(['deleted' => 1]);
    }

    public function rename(Request $request, string $id): JsonResponse
    {
        $data = $request->validate(['title' => 'required|string|max:120']);
        $conversation = $this->conversations->find($request->user(), $id);
        $conversation->update(['title' => trim($data['title'])]);

        return response()->json(['conversation' => $conversation->present()]);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $this->conversations->find($request->user(), $id)->delete();
        $this->audit->log($request->user(), 'conversation_deleted', $request, ['deleted' => 1]);

        return response()->json(['deleted' => 1]);
    }

    public function destroyAll(Request $request): JsonResponse
    {
        $deleted = Conversation::where('user_id', $request->user()->id)->delete();
        $this->audit->log($request->user(), 'conversation_deleted', $request, ['deleted' => $deleted]);

        return response()->json(['deleted' => $deleted]);
    }

    public function message(Request $request): JsonResponse|StreamedResponse
    {
        $data = $request->validate([
            'conversation_id' => 'nullable|uuid',
            'message' => 'required_without:choice|nullable|string|max:4000',
            'language' => 'required|in:en,ar',
            'client_id' => ['nullable', 'string', 'max:64', 'regex:/^[A-Za-z0-9_-]+$/'],
            'choice' => 'nullable|array',
            'choice.type' => 'required_with:choice|in:option,alternative',
            'choice.message_id' => 'required_with:choice|integer',
            'choice.value' => 'required_with:choice|string|max:120',
        ]);
        $user = $request->user();
        $run = fn (?callable $progress = null) => $this->conversations->send($user, $data['conversation_id'] ?? null, (string) ($data['message'] ?? ''), $data['language'], $data['client_id'] ?? null, $data['choice'] ?? null, $progress);

        if (! str_contains((string) $request->header('Accept'), 'text/event-stream')) {
            try {
                return response()->json($run());
            } catch (ValidationException|HttpExceptionInterface|ModelNotFoundException $e) {
                throw $e;
            } catch (Throwable $e) {
                report($e);

                return response()->json(['message' => 'The assistant is unavailable. Your data has not been changed.'], 503);
            }
        }

        return response()->stream(function () use ($run) {
            $send = function (string $event, array $payload) {
                echo "event: {$event}\ndata: ".json_encode($payload, JSON_UNESCAPED_UNICODE)."\n\n";
                if (ob_get_level() > 0) {
                    ob_flush();
                }
                flush();
            };
            try {
                $send('done', $run(fn (string $stage) => $send('stage', ['stage' => $stage])));
            } catch (HttpExceptionInterface $e) {
                $send('error', ['status' => $e->getStatusCode(), 'message' => $e->getMessage() ?: 'Request failed.']);
            } catch (ModelNotFoundException) {
                $send('error', ['status' => 404, 'message' => 'Conversation not found.']);
            } catch (Throwable $e) {
                report($e);
                $send('error', ['status' => 503, 'message' => 'The assistant is unavailable. Your data has not been changed.']);
            }
        }, 200, ['Content-Type' => 'text/event-stream', 'Cache-Control' => 'no-cache, no-store', 'X-Accel-Buffering' => 'no']);
    }
}
