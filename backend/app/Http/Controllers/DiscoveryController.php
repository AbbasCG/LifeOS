<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\DiscoveryStateService;
use App\Services\Discovery\FeatureGate;
use App\Services\Discovery\InvalidDiscoveryContentException;
use App\Services\Discovery\Localized;
use App\Services\Discovery\ReleaseService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * What's New, feature discovery and tour progress for the signed-in person. Everything is about their own data; nothing
 * here accepts text from the client, and a route or tour is only ever taken from the reviewed content files.
 */
class DiscoveryController extends Controller
{
    public function __construct(private ReleaseService $releases, private DiscoveryStateService $states, private DiscoveryRegistry $registry, private FeatureGate $gate) {}

    /** One small request when the app opens: the announcement to show (if any) and the badge counts. */
    public function bootstrap(Request $request): JsonResponse
    {
        [$surface, $client] = $this->context($request);
        $user = $request->user();
        try {
            $result = $this->releases->announcement($user, $surface, $client);
        } catch (InvalidDiscoveryContentException $e) {
            // Broken content must never break the app: show nothing, and report it.
            report($e);
            $result = ['announcement' => null, 'update_required' => false, 'unseen' => 0];
        }
        if ($result['announcement']) {
            try {
                $this->releases->notify($user, $result['announcement']);
            } catch (\Throwable $e) {
                // A notification that could not be written must never stop the app from opening.
                report($e);
            }
        }

        return response()->json(['data' => [
            'announcement' => $result['announcement'], 'update_required' => $result['update_required'], 'counts' => ['unseen_updates' => $result['unseen']],
            'preferences' => ['hints_enabled' => (bool) (($user->preferences()['discovery']['hints_enabled'] ?? true))],
        ]]);
    }

    /** "New" badges and the contextual hints that are due; empty when content is broken, never an error. */
    public function guide(Request $request): JsonResponse
    {
        [$surface, $client] = $this->context($request);
        try {
            $guide = $this->releases->guide($request->user(), $surface, $client);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);
            $guide = ['new' => [], 'hints' => []];
        }

        return response()->json(['data' => $guide]);
    }

    /**
     * One tour, in the person's language, with where they stopped. Only a tour of a live, approved release that this account may use exists;
     * anything else is a 404, so the answer reveals nothing about tours the person cannot see.
     */
    public function tour(Request $request, string $id): JsonResponse
    {
        abort_unless(preg_match(DiscoveryRegistry::SLUG, $id) === 1, 404);
        $user = $request->user();
        try {
            $tour = $this->registry->tour($id);
            abort_unless($tour && $this->states->exists($user, 'tour', $id), 404);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);
            abort(404);
        }
        $language = Localized::of($user->preferences());
        $state = $this->states->find($user, 'tour', $id);
        $steps = array_map(fn (array $step) => [
            'target' => $step['target'], 'route' => $step['route'], 'reveal' => $step['reveal'], 'placement' => $step['placement'], 'optional' => $step['optional'],
            'title' => Localized::pick($step['title'], $language), 'body' => Localized::pick($step['body'], $language),
        ], $tour['steps']);

        return response()->json(['data' => [
            'id' => $id, 'version' => $tour['version'], 'title' => Localized::pick($tour['title'], $language), 'steps' => $steps,
            'state' => ['step_index' => (int) ($state?->step_index ?? 0), 'completed' => (bool) $state?->completed_at, 'skipped' => (bool) $state?->skipped_at],
        ]]);
    }

    /** The Discovery Center: every feature this person can discover or replay. Broken content gives an empty list, never an error. */
    public function features(Request $request): JsonResponse
    {
        [$surface, $client] = $this->context($request);
        try {
            $features = $this->releases->catalogue($request->user(), $surface, $client);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);
            $features = [];
        }

        return response()->json(['data' => $features]);
    }

    /** The update history: every approved, live release for this surface, newest first. */
    public function releases(Request $request): JsonResponse
    {
        [$surface, $client] = $this->context($request);
        try {
            $history = $this->releases->history($request->user(), $surface, $client);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);
            $history = [];
        }

        return response()->json(['data' => $history]);
    }

    public function state(Request $request, string $type, string $key): JsonResponse
    {
        $data = $request->validate([
            'action' => ['required', Rule::in(DiscoveryStateService::ACTIONS)],
            'step_index' => ['sometimes', 'integer', 'min:0', 'max:200'],
            'surface' => ['sometimes', Rule::in(DiscoveryRegistry::SURFACES)],
        ]);
        // Only subjects that exist (and, for announcements and features, are live and approved) can have a state: no arbitrary keys.
        abort_unless($this->exists($request->user(), $type, $key), 404);
        $state = $this->states->record($request->user(), $type, $key, $data['action'], $data['surface'] ?? null, $data['step_index'] ?? null);

        return response()->json(['data' => $state->present()]);
    }

    /** "Try now": checks the feature is available to this person right now, and answers with where to go. */
    public function tryFeature(Request $request, string $id): JsonResponse
    {
        [$surface, $client] = $this->context($request);
        try {
            $feature = $this->registry->feature($id);
            abort_unless($feature && $this->releases->isVisible($feature['since']), 404);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);
            abort(404);
        }
        $user = $request->user();
        $access = $this->gate->check($user, $feature['requires']);
        $reason = ! $access['available'] ? $access['reason']
            : (! in_array($surface, $feature['audiences'], true) ? 'platform' : ($client < $feature['client_version'] ? 'update_required' : null));
        // An administrator-only feature does not exist for anyone else.
        abort_if($reason === 'admin_only', 404);
        if ($reason) {
            return response()->json(['data' => ['available' => false, 'reason' => $reason, 'route' => null, 'tour' => null]]);
        }
        $this->states->tried($user, $id, $surface);
        $tour = $feature['tour'];
        $tourState = $tour ? $this->states->find($user, 'tour', $tour) : null;

        return response()->json(['data' => ['available' => true, 'reason' => null, 'route' => $feature['route'], 'tour' => $tour && ! $tourState?->completed_at ? $tour : null]]);
    }

    private function exists(User $user, string $type, string $key): bool
    {
        try {
            return $this->states->exists($user, $type, $key);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);

            return false;
        }
    }

    /** @return array{0: string, 1: int} */
    private function context(Request $request): array
    {
        $data = $request->validate(['surface' => ['sometimes', Rule::in(DiscoveryRegistry::SURFACES)], 'client' => ['sometimes', 'integer', 'min:0', 'max:100000']]);

        return [$data['surface'] ?? 'web', (int) ($data['client'] ?? 1)];
    }
}
