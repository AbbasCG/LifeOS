<?php

namespace App\Http\Controllers;

use App\Models\Conversation;
use App\Services\AuditLogger;
use App\Services\ConversationService;
use App\Services\IntelligenceSettings;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
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

        return response()->json([
            'conversations' => $this->conversations->list($user)->map->present()->values(),
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
