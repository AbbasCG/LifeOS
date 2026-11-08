<?php

namespace App\Http\Controllers;

use App\Models\DiscoveryTester;
use App\Models\ProductRelease;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\Discovery\DeployConfirmation;
use App\Services\Discovery\DiscoveryStats;
use App\Services\Discovery\InvalidDiscoveryContentException;
use App\Services\Discovery\ReleaseService;
use App\Services\Discovery\ReleaseStateException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Administrator-only: which releases the running code contains, and the decision to publish or withdraw each. Approval
 * is only possible for a release a healthy deploy has confirmed; withdrawing works at any time and takes effect at once.
 */
class AdminReleaseController extends Controller
{
    public function __construct(private ReleaseService $releases, private DeployConfirmation $deploy, private AuditLogger $audit) {}

    public function index(): JsonResponse
    {
        $state = $this->deploy->inspect();
        try {
            $list = $this->releases->adminList();
        } catch (InvalidDiscoveryContentException $e) {
            report($e);

            return response()->json(['message' => 'The announcement files in the running code are invalid: '.$e->getMessage(), 'code' => 'content_invalid'], 503);
        }

        return response()->json(['data' => $list, 'activation' => ['enabled' => $state['enabled'], 'status' => $state['status'], 'detail' => $state['detail'], 'auto_approve' => (bool) config('discovery.auto_approve')]]);
    }

    /** How the updates were received, as counts only (see DiscoveryStats). Content problems give an empty list, never an error. */
    public function stats(DiscoveryStats $stats): JsonResponse
    {
        try {
            $data = $stats->all();
        } catch (InvalidDiscoveryContentException $e) {
            report($e);
            $data = ['accounts' => 0, 'releases' => []];
        }

        return response()->json(['data' => $data]);
    }

    /** Approves the text with the given fingerprint (read it from the list first): if the text has changed since, the answer is a 409. */
    public function approve(Request $request, string $key): JsonResponse
    {
        $this->shape($key);
        $data = $request->validate(['content_hash' => ['required', 'string', 'size:64']]);

        return $this->decide($request, $key, 'release_approved', fn () => $this->releases->approve($key, $request->user(), $data['content_hash']));
    }

    public function withdraw(Request $request, string $key): JsonResponse
    {
        $this->shape($key);

        return $this->decide($request, $key, 'release_withdrawn', fn () => $this->releases->withdraw($key, $request->user()));
    }

    /** Who may see a release: administrators only, administrators and test accounts, or everyone. Takes effect at once; needs no deploy. */
    public function rollout(Request $request, string $key): JsonResponse
    {
        $this->shape($key);
        $data = $request->validate(['stage' => ['required', 'string', Rule::in(ProductRelease::ROLLOUTS)]]);
        try {
            $before = ProductRelease::where('key', $key)->value('rollout');
            $row = $this->releases->setRollout($key, $data['stage']);
        } catch (ReleaseStateException $e) {
            return response()->json(['message' => $e->getMessage(), 'code' => $e->errorCode], $e->status);
        }
        if ($before !== $row->rollout) {
            $this->audit->log($request->user(), 'release_rollout_changed', $request, ['release' => $key, 'from' => $before, 'to' => $row->rollout]);
        }

        return response()->json(['data' => ['key' => $row->key, 'rollout' => $row->rollout, 'visible' => $row->isVisible()]]);
    }

    /** The test accounts of the "internal" stage: who they are is for administrators only. */
    public function testers(): JsonResponse
    {
        return response()->json(['data' => DiscoveryTester::with('user:id,name,email')->orderBy('id')->get()->map(fn (DiscoveryTester $t) => ['id' => $t->user_id, 'name' => $t->user?->name, 'email' => $t->user?->email])->values()]);
    }

    public function addTester(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => ['required', 'email', 'max:255']]);
        // The same answer whether or not the account exists would hide a typo from the administrator; this screen is for administrators only.
        $user = User::where('email', $data['email'])->first();
        if (! $user) {
            return response()->json(['message' => 'No account has this e-mail address.', 'code' => 'user_unknown'], 404);
        }
        $tester = DiscoveryTester::firstOrCreate(['user_id' => $user->id], ['added_by' => $request->user()->id]);
        if ($tester->wasRecentlyCreated) {
            $this->audit->log($request->user(), 'discovery_tester_added', $request, ['user' => $user->id]);
        }

        return response()->json(['data' => ['id' => $user->id, 'name' => $user->name, 'email' => $user->email]], $tester->wasRecentlyCreated ? 201 : 200);
    }

    public function removeTester(Request $request, int $user): JsonResponse
    {
        if (DiscoveryTester::where('user_id', $user)->delete() > 0) {
            $this->audit->log($request->user(), 'discovery_tester_removed', $request, ['user' => $user]);
        }

        return response()->json(['data' => ['id' => $user]]);
    }

    /** A release key is a short slug; anything else cannot exist (and must not reach the database). */
    private function shape(string $key): void
    {
        abort_unless(preg_match('/^[a-z0-9][a-z0-9-]{1,62}$/D', $key) === 1, 404);
    }

    private function decide(Request $request, string $key, string $action, callable $change): JsonResponse
    {
        try {
            $row = $change();
        } catch (ReleaseStateException $e) {
            return response()->json(['message' => $e->getMessage(), 'code' => $e->errorCode], $e->status);
        } catch (InvalidDiscoveryContentException $e) {
            report($e);

            return response()->json(['message' => 'The announcement files in the running code are invalid.', 'code' => 'content_invalid'], 503);
        }
        // The entry names the release and its revision only: no announcement text. A repeated click that changed nothing is not logged.
        if ($row->wasChanged('review_status')) {
            $this->audit->log($request->user(), $action, $request, ['release' => $key, 'revision' => $row->revision]);
        }

        return response()->json(['data' => ['key' => $row->key, 'review_status' => $row->review_status, 'deploy_status' => $row->deploy_status, 'visible' => $row->isVisible()]]);
    }
}
