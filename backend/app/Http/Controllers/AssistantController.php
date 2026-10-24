<?php

namespace App\Http\Controllers;

use App\Integrations\Ai\AiProviders;
use App\Models\AssistantProposal;
use App\Services\AssistantActions;
use App\Services\AssistantService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class AssistantController extends Controller
{
    public function respond(Request $request, AssistantService $assistant): JsonResponse
    {
        $data = $request->validate(['message' => 'required|string|max:4000', 'language' => 'required|in:en,ar']);
        try {
            return response()->json($assistant->respond($request->user(), $data['message'], $data['language']));
        } catch (ValidationException $e) {
            throw $e;
        } catch (\Throwable $e) {
            report($e);

            return response()->json(['message' => 'The assistant is unavailable. Your data has not been changed.'], 503);
        }
    }

    /**
     * Which assistant answers for this user. Never includes credentials.
     */
    public function status(Request $request, AssistantService $assistant, AiProviders $providers): JsonResponse
    {
        $active = $assistant->provider($request->user());

        return response()->json([
            'active' => $active ? ['provider' => $active->name(), 'label' => $active->label(), 'model' => $active->model()] : ['provider' => 'local', 'label' => 'Local assistant', 'model' => null],
            'selected' => (string) config('ai.provider'),
            'external_allowed' => (bool) ($request->user()->preferences()['assistant_external'] ?? true),
            'providers' => collect($providers->all())->map(fn ($p) => ['provider' => $p->name(), 'label' => $p->label(), 'configured' => $p->isConfigured(), 'selected' => config('ai.provider') === $p->name(), 'model' => $p->model()])->values(),
        ]);
    }

    /**
     * Suggestions that are still waiting for the user's decision.
     */
    public function pending(Request $request): JsonResponse
    {
        return response()->json(AssistantProposal::where('user_id', $request->user()->id)->where('status', 'pending')->where('expires_at', '>', now())
            ->latest()->limit(10)->get()->map(fn (AssistantProposal $p) => $p->present())->values());
    }

    public function proposal(Request $request, string $id): JsonResponse
    {
        return response()->json($this->find($request, $id)->present());
    }

    public function apply(Request $request, string $id, AssistantActions $actions): JsonResponse
    {
        $data = $request->validate(['action_ids' => 'required|array|min:1|max:20', 'action_ids.*' => 'required|string|max:10|distinct']);

        return response()->json($actions->apply($request->user(), $this->find($request, $id), $data['action_ids'], $request)->present());
    }

    public function dismiss(Request $request, string $id, AssistantActions $actions): JsonResponse
    {
        return response()->json($actions->dismiss($this->find($request, $id))->present());
    }

    private function find(Request $request, string $id): AssistantProposal
    {
        abort_unless(preg_match('/^[0-9a-f-]{36}$/', $id) === 1, 404);

        return AssistantProposal::where('user_id', $request->user()->id)->findOrFail($id);
    }
}
