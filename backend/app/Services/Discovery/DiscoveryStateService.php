<?php

namespace App\Services\Discovery;

use App\Models\InboxNotification;
use App\Models\User;
use App\Models\UserDiscoveryState;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Records what a person does with an announcement, feature, tour or hint. Only keys and timestamps are kept. A state only
 * moves forward: a finished tour does not become "started" again, and the first time something was seen stays the first time.
 */
class DiscoveryStateService
{
    public const ACTIONS = ['seen', 'snoozed', 'dismissed', 'started', 'step', 'completed', 'skipped', 'helpful', 'unhelpful'];

    public function __construct(private DiscoveryRegistry $registry, private ReleaseService $releases, private FeatureGate $gate) {}

    /**
     * Whether this person may have a state for the subject: it exists, it belongs to a release that is live and approved, and it is not
     * something only administrators know about (which must not be discoverable from the answer).
     */
    public function exists(User $user, string $type, string $key): bool
    {
        return match ($type) {
            'release' => $this->releases->isVisible($key, $user),
            'feature' => ($feature = $this->registry->feature($key)) !== null && $this->reachable($user, $feature),
            'tour' => $this->tourReachable($user, $key),
            'hint' => ($owner = $this->registry->hintFeature($key)) !== null && $this->reachable($user, $this->registry->feature($owner)),
            default => false,
        };
    }

    /** @param  array<string, mixed>  $feature */
    private function reachable(User $user, array $feature): bool
    {
        return $this->releases->isVisible($feature['since'], $user) && $this->gate->check($user, $feature['requires'])['reason'] !== 'admin_only';
    }

    private function tourReachable(User $user, string $id): bool
    {
        foreach ($this->registry->features() as $feature) {
            if ($feature['tour'] === $id && $this->reachable($user, $feature)) {
                return true;
            }
        }

        return false;
    }

    /** The version a state is kept under: a tour has its own version, so a rewritten tour can be offered again; everything else is 1. */
    public function versionOf(string $type, string $key): int
    {
        return $type === 'tour' ? (int) ($this->registry->tour($key)['version'] ?? 1) : 1;
    }

    public function record(User $user, string $type, string $key, string $action, ?string $surface = null, ?int $step = null): UserDiscoveryState
    {
        $state = $this->state($user, $type, $key);
        $now = now();
        match ($action) {
            // Being shown again after a postponement ends that postponement.
            'seen' => $state->forceFill(['seen_at' => $state->seen_at ?? $now, 'snoozed_until' => $state->snoozed_until?->isPast() ? null : $state->snoozed_until]),
            'snoozed' => $this->snooze($state, $now),
            'dismissed' => $state->forceFill(['seen_at' => $state->seen_at ?? $now, 'dismissed_at' => $state->dismissed_at ?? $now, 'snoozed_until' => null]),
            'started' => $state->completed_at || $state->skipped_at ? null : $state->forceFill(['started_at' => $state->started_at ?? $now]),
            'step' => $state->completed_at ? null : $state->forceFill(['started_at' => $state->started_at ?? $now, 'step_index' => max(0, min(200, (int) $step))]),
            'completed' => $state->forceFill(['started_at' => $state->started_at ?? $now, 'completed_at' => $state->completed_at ?? $now]),
            'skipped' => $state->completed_at ? null : $state->forceFill(['started_at' => $state->started_at ?? $now, 'skipped_at' => $state->skipped_at ?? $now]),
            'helpful' => $state->forceFill(['helpful' => true]),
            'unhelpful' => $state->forceFill(['helpful' => false]),
        };
        if ($surface) {
            $state->surface = $surface;
        }
        $state->save();
        // Reading an announcement clears its notification: nothing is left in the inbox for what the person has seen.
        if ($type === 'release' && in_array($action, ['seen', 'dismissed', 'snoozed'], true)) {
            InboxNotification::where('user_id', $user->id)->where('deduplication_key', 'release:'.$key.':'.$user->id)->delete();
        }

        return $state;
    }

    /** "I tried it": the first time is kept. */
    public function tried(User $user, string $key, ?string $surface = null): UserDiscoveryState
    {
        $state = $this->state($user, 'feature', $key);
        $state->forceFill(['tried_at' => $state->tried_at ?? now(), 'surface' => $surface ?? $state->surface])->save();

        return $state;
    }

    public function find(User $user, string $type, string $key): ?UserDiscoveryState
    {
        return UserDiscoveryState::where(['user_id' => $user->id, 'subject_type' => $type, 'subject_key' => $key, 'version' => $this->versionOf($type, $key)])->first();
    }

    private function snooze(UserDiscoveryState $state, \DateTimeInterface $now): void
    {
        // Already history only, or already postponed: a repeated tap on "Later" is not a second postponement.
        if ($state->dismissed_at || $state->snoozed_until?->isFuture()) {
            return;
        }
        $count = $state->snooze_count + 1;
        // After the allowed postponements the announcement stays in the update history only.
        if ($count > (int) config('discovery.max_snoozes')) {
            $state->forceFill(['seen_at' => $state->seen_at ?? $now, 'dismissed_at' => $state->dismissed_at ?? $now, 'snoozed_until' => null, 'snooze_count' => $count]);

            return;
        }
        $state->forceFill(['seen_at' => $state->seen_at ?? $now, 'snooze_count' => $count, 'snoozed_until' => now()->addHours((int) config('discovery.snooze_hours'))]);
    }

    private function state(User $user, string $type, string $key): UserDiscoveryState
    {
        $keys = ['user_id' => $user->id, 'subject_type' => $type, 'subject_key' => $key, 'version' => $this->versionOf($type, $key)];
        try {
            return UserDiscoveryState::firstOrCreate($keys);
        } catch (UniqueConstraintViolationException) {
            // Two requests created the row at once; the other one won, so read it.
            return UserDiscoveryState::where($keys)->firstOrFail();
        }
    }
}
