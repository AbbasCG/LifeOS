<?php

namespace App\Services\Discovery;

use App\Models\DiscoveryTester;
use App\Models\ProductRelease;
use App\Models\User;
use App\Models\UserDiscoveryState;
use Illuminate\Database\Eloquent\Builder;

/**
 * How updates were received, as counts and nothing else: how many accounts saw, dismissed or rated an announcement, tried a feature, started, finished or
 * skipped a tour, and saw or dismissed a hint. No account, e-mail or name is ever part of the answer, and nothing is stored for it: the numbers are
 * counted from the per-person states that exist anyway (keys and timestamps, see UserDiscoveryState).
 */
class DiscoveryStats
{
    public function __construct(private DiscoveryRegistry $registry) {}

    /** @return array{accounts: int, releases: list<array<string, mixed>>} */
    public function all(): array
    {
        $releases = [];
        foreach (array_keys($this->registry->releases()) as $key) {
            $releases[] = $this->release($key);
        }

        return ['accounts' => User::count(), 'releases' => $releases];
    }

    /** @return array<string, mixed> */
    private function release(string $key): array
    {
        $scope = $this->registry->scope($key);
        $row = ProductRelease::where('key', $key)->first();
        $announcement = $this->states('release', $key, 1);
        $features = [];
        foreach ($scope['features'] as $feature) {
            $tour = null;
            if ($feature['tour']) {
                $version = (int) ($this->registry->tour($feature['tour'])['version'] ?? 1);
                $states = $this->states('tour', $feature['tour'], $version);
                $tour = ['id' => $feature['tour'], 'version' => $version, 'started' => (clone $states)->whereNotNull('started_at')->count(),
                    'completed' => (clone $states)->whereNotNull('completed_at')->count(), 'skipped' => (clone $states)->whereNotNull('skipped_at')->count()];
            }
            $hints = [];
            foreach ($feature['hints'] as $hint) {
                $hintStates = $this->states('hint', $hint['id'], 1);
                $hints[] = ['id' => $hint['id'], 'shown' => (clone $hintStates)->whereNotNull('seen_at')->count(), 'dismissed' => (clone $hintStates)->whereNotNull('dismissed_at')->count()];
            }
            $features[] = ['id' => $feature['id'], 'tried' => $this->states('feature', $feature['id'], 1)->whereNotNull('tried_at')->count(), 'tour' => $tour, 'hints' => $hints];
        }

        return [
            'key' => $key, 'rollout' => $row?->rollout ?? ProductRelease::ROLLOUT_GENERAL, 'eligible' => $this->eligible($row),
            'seen' => (clone $announcement)->whereNotNull('seen_at')->count(),
            'dismissed' => (clone $announcement)->whereNotNull('dismissed_at')->count(),
            'snoozed' => (clone $announcement)->where('snoozed_until', '>', now())->count(),
            'helpful' => (clone $announcement)->where('helpful', true)->count(),
            'unhelpful' => (clone $announcement)->where('helpful', false)->count(),
            'features' => $features,
        ];
    }

    /**
     * How many accounts could be shown this release: those its stage includes, and who had an account when it was published (later accounts find it in the
     * history only, see ReleaseService::announcement). A number only; no account is named. 0 while the release is not registered.
     */
    private function eligible(?ProductRelease $row): int
    {
        if (! $row) {
            return 0;
        }
        $published = $row->published_at ?? $row->live_since;
        $users = User::query()->when($published, fn (Builder $q) => $q->where('created_at', '<=', $published));

        return match ($row->rollout) {
            ProductRelease::ROLLOUT_GENERAL => $users->count(),
            ProductRelease::ROLLOUT_INTERNAL => $users->where(fn (Builder $q) => $q->where('is_admin', true)->orWhereIn('id', DiscoveryTester::query()->select('user_id')))->count(),
            ProductRelease::ROLLOUT_ADMIN => $users->where('is_admin', true)->count(),
            default => 0,
        };
    }

    /** @return Builder<UserDiscoveryState> */
    private function states(string $type, string $key, int $version)
    {
        return UserDiscoveryState::where(['subject_type' => $type, 'subject_key' => $key, 'version' => $version]);
    }
}
