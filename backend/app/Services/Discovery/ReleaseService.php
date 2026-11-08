<?php

namespace App\Services\Discovery;

use App\Models\InboxNotification;
use App\Models\ProductRelease;
use App\Models\User;
use App\Models\UserDiscoveryState;
use App\Services\Notifier;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Collection;

/**
 * Release lifecycle and what each person is shown.
 *
 *   file in the deployed tree  --reconcile (only after a healthy deploy)-->  row, deploy_status "live", review_status "draft"
 *   administrator approves  -->  "approved"        administrator withdraws  -->  "withdrawn" (hidden at once, no deploy needed)
 *   file gone from the tree (rollback)  -->  deploy_status "absent"           file back (roll forward)  -->  "live" again
 *
 * A release is shown only when it is approved AND live AND its content file is present AND the text now in the code is exactly the
 * text that was approved (equal fingerprints), so neither a merge, nor a green CI run, nor a draft, nor an edit made after the
 * approval can put an announcement in front of anyone. The activation switch (config discovery.auto_activate) is a real kill
 * switch: while it is off nothing is shown, whatever the table holds.
 */
class ReleaseService
{
    /** @var Collection<string, ProductRelease>|null */
    private ?Collection $visible = null;

    public function __construct(private DiscoveryRegistry $registry, private FeatureGate $gate, private DeployConfirmation $deploy, private Notifier $notifier) {}

    // ---- activation (scheduled; a no-op unless a healthy deploy is confirmed) ----

    /**
     * @return array{status: string, detail: string, registered: list<string>, updated: list<string>, absent: list<string>, needs_review: list<string>}
     */
    public function reconcile(bool $dryRun = false): array
    {
        $state = $this->deploy->inspect();
        $result = ['status' => $state['status'], 'detail' => $state['detail'], 'registered' => [], 'updated' => [], 'absent' => [], 'needs_review' => []];
        if ($state['status'] !== 'confirmed') {
            return $result;
        }
        $sha = (string) $state['marker'];
        $now = now();
        try {
            $releases = $this->registry->releases();
        } catch (InvalidDiscoveryContentException $e) {
            // Broken content in the running code: change nothing (what is already approved stays as it was) and say why.
            return ['status' => 'content_invalid', 'detail' => $e->getMessage()] + $result;
        }
        $rows = ProductRelease::all()->keyBy('key');
        foreach ($releases as $key => $release) {
            $row = $rows[$key] ?? null;
            if (! $row) {
                $result['registered'][] = $key;
                if (! $dryRun) {
                    ProductRelease::create(['key' => $key, 'revision' => $release['revision'], 'importance' => $release['importance'], 'review_status' => ProductRelease::DRAFT,
                        'content_hash' => $this->registry->fingerprint($key), 'deploy_status' => ProductRelease::LIVE, 'deployed_sha' => $sha, 'live_since' => $now, 'last_confirmed_at' => $now]);
                }

                continue;
            }
            $hash = $this->registry->fingerprint($key);
            $changed = $row->deploy_status !== ProductRelease::LIVE || $row->revision !== $release['revision'] || $row->importance !== $release['importance'] || $row->deployed_sha !== $sha || $row->content_hash !== $hash;
            if ($changed) {
                $result['updated'][] = $key;
            }
            // Text that changed after it was approved is a new draft: the administrator approves what the code says now.
            $revised = $row->review_status === ProductRelease::APPROVED && $row->approved_hash !== $hash;
            if ($revised) {
                $result['needs_review'][] = $key;
            }
            if (! $dryRun) {
                $row->forceFill(['deploy_status' => ProductRelease::LIVE, 'absent_since' => null, 'revision' => $release['revision'], 'importance' => $release['importance'], 'deployed_sha' => $sha,
                    'content_hash' => $hash, 'last_confirmed_at' => $now] + ($revised ? ['review_status' => ProductRelease::DRAFT] : []))->save();
            }
        }
        foreach ($rows as $key => $row) {
            if ($this->registry->release($key) === null && $row->deploy_status !== ProductRelease::ABSENT) {
                $result['absent'][] = $key;
                if (! $dryRun) {
                    $row->forceFill(['deploy_status' => ProductRelease::ABSENT, 'absent_since' => $now, 'last_confirmed_at' => $now])->save();
                }
            }
        }
        $this->visible = null;

        return $result;
    }

    // ---- administrator decisions ----

    /** Approves exactly the text with this fingerprint; if the code holds other text by now, the answer is a 409 and nothing changes. */
    public function approve(string $key, User $admin, string $contentHash): ProductRelease
    {
        $row = $this->liveRow($key);
        $current = $this->registry->fingerprint($key);
        if ($current === null || ! hash_equals($current, $contentHash)) {
            throw new ReleaseStateException('content_changed', 'The announcement changed after you opened it. Review the current text and approve again.');
        }
        if ($row->review_status === ProductRelease::APPROVED && $row->approved_hash === $current) {
            return $row;
        }
        $row->forceFill(['approved_hash' => $current, 'content_hash' => $current, 'published_at' => $row->published_at ?? now()]);

        return $this->review($row, ProductRelease::APPROVED, $admin);
    }

    public function withdraw(string $key, User $admin): ProductRelease
    {
        $row = ProductRelease::where('key', $key)->first() ?? throw new ReleaseStateException('release_unknown', 'No such release.', 404);
        if ($row->review_status === ProductRelease::WITHDRAWN) {
            return $row;
        }

        return $this->review($row, ProductRelease::WITHDRAWN, $admin);
    }

    private function liveRow(string $key): ProductRelease
    {
        $row = ProductRelease::where('key', $key)->first();
        if (! $row || $this->registry->release($key) === null) {
            throw new ReleaseStateException('not_deployed', 'This release is not part of a confirmed healthy deploy yet, so it cannot be approved.');
        }
        if ($row->deploy_status !== ProductRelease::LIVE) {
            throw new ReleaseStateException('not_live', 'This release is not in the code that is running now.');
        }

        return $row;
    }

    private function review(ProductRelease $row, string $status, User $admin): ProductRelease
    {
        $row->forceFill(['review_status' => $status, 'reviewed_by' => $admin->id, 'reviewed_at' => now()])->save();
        $this->visible = null;

        return $row;
    }

    /** @return list<array<string, mixed>> every release in the code with its runtime state, for the administrator screen */
    public function adminList(): array
    {
        $rows = ProductRelease::all()->keyBy('key');
        $out = [];
        foreach ($this->registry->releases() as $key => $release) {
            $row = $rows[$key] ?? null;
            $out[] = ['key' => $key, 'date' => $release['date'], 'revision' => $release['revision'], 'importance' => $release['importance'], 'title' => $release['title'], 'items' => count($release['items']),
                'registered' => $row !== null, 'review_status' => $row?->review_status, 'deploy_status' => $row?->deploy_status, 'deployed_sha' => $row?->deployed_sha,
                'content_hash' => $this->registry->fingerprint($key), 'approved_hash' => $row?->approved_hash,
                'live_since' => $row?->live_since?->toIso8601String(), 'reviewed_at' => $row?->reviewed_at?->toIso8601String(), 'visible' => (bool) $row?->isVisible()];
        }

        return $out;
    }

    // ---- what a person sees ----

    /** @return Collection<string, ProductRelease> visible rows whose content is present and unchanged since it was approved, newest release first */
    public function visibleRows(): Collection
    {
        if ($this->visible !== null) {
            return $this->visible;
        }
        if (! config('discovery.auto_activate')) {
            return $this->visible = collect();
        }
        $rows = ProductRelease::where('review_status', ProductRelease::APPROVED)->where('deploy_status', ProductRelease::LIVE)->get()->keyBy('key');

        return $this->visible = collect($this->registry->releases())
            ->filter(fn (array $r, string $key) => isset($rows[$key]) && $rows[$key]->approved_hash !== null && hash_equals($rows[$key]->approved_hash, (string) $this->registry->fingerprint($key)))
            ->map(fn (array $r, string $key) => $rows[$key]);
    }

    public function isVisible(string $key): bool
    {
        return $this->visibleRows()->has($key);
    }

    /**
     * The announcement to show now (at most one), plus the count of others waiting.
     *
     * @return array{announcement: ?array<string, mixed>, update_required: bool, unseen: int}
     */
    public function announcement(User $user, string $surface, int $client): array
    {
        $states = $this->states($user, 'release');
        $language = Localized::of($user->preferences());
        $candidates = [];
        $updateRequired = false;
        foreach ($this->visibleRows() as $key => $row) {
            $release = $this->registry->release($key);
            if (! in_array($surface, $release['audiences'], true)) {
                continue;
            }
            // Someone who joined after the release was published has never lived without it: it is in the history only.
            $published = $row->published_at ?? $row->live_since;
            if ($published && $user->created_at && $user->created_at->greaterThan($published)) {
                continue;
            }
            if (! $this->due($states[$key] ?? null)) {
                continue;
            }
            // A tab opened before the update cannot run the new screens: ask for a reload instead of promising what it cannot show.
            if ($client < $release['min_client']) {
                $updateRequired = true;

                continue;
            }
            $candidates[] = [$release, $row];
        }
        $first = $candidates[0] ?? null;
        $context = $first ? $this->context($user) : null;

        return [
            'announcement' => $first ? $this->present($first[0], $first[1], $user, $surface, $client, $language, $context) : null,
            'update_required' => $updateRequired,
            'unseen' => count($candidates),
        ];
    }

    /** Whether the person still has to see this announcement: not dismissed, not already shown, and not postponed. */
    private function due(?UserDiscoveryState $state): bool
    {
        if (! $state) {
            return true;
        }
        if ($state->dismissed_at) {
            return false;
        }
        if ($state->snoozed_until) {
            return $state->snoozed_until->isPast();
        }

        return $state->seen_at === null;
    }

    /** @return list<array<string, mixed>> */
    public function history(User $user, string $surface, int $client): array
    {
        $states = $this->states($user, 'release');
        $language = Localized::of($user->preferences());
        $context = $this->context($user);
        $out = [];
        foreach ($this->visibleRows() as $key => $row) {
            $release = $this->registry->release($key);
            if (! in_array($surface, $release['audiences'], true)) {
                continue;
            }
            $state = $states[$key] ?? null;
            $out[] = $this->present($release, $row, $user, $surface, $client, $language, $context) + ['seen' => (bool) ($state?->seen_at || $state?->dismissed_at), 'helpful' => $state?->helpful];
        }

        return $out;
    }

    /**
     * One in-app notification per person per release, only for important releases and only if their settings allow it. The
     * moment it was created is remembered on the person's own state, so deleting the notification does not bring it back, and a
     * notification held back by quiet hours or by settings is tried again later.
     */
    public function notify(User $user, array $announcement): void
    {
        if (($announcement['importance'] ?? 'normal') !== 'important') {
            return;
        }
        $keys = ['user_id' => $user->id, 'subject_type' => 'release', 'subject_key' => $announcement['key'], 'version' => 1];
        try {
            $state = UserDiscoveryState::firstOrCreate($keys);
        } catch (UniqueConstraintViolationException) {
            $state = UserDiscoveryState::where($keys)->firstOrFail();
        }
        if ($state->notified_at) {
            return;
        }
        $dedup = 'release:'.$announcement['key'].':'.$user->id;
        $sent = $this->notifier->send($user, 'updates', $dedup, $announcement['title'], ['body' => $announcement['summary'], 'link' => '/updates?release='.$announcement['key'], 'kind' => 'release']);
        if ($sent !== null || InboxNotification::where('deduplication_key', $dedup)->exists()) {
            $state->forceFill(['notified_at' => now()])->save();
        }
    }

    /**
     * What is read once per request and shared by every item: the person's feature and tour states.
     *
     * @return array{features: Collection<string, UserDiscoveryState>, tours: Collection<string, UserDiscoveryState>}
     */
    private function context(User $user): array
    {
        return ['features' => $this->states($user, 'feature'), 'tours' => $this->states($user, 'tour')];
    }

    /**
     * @param  array<string, mixed>  $release
     * @param  array{features: Collection<string, UserDiscoveryState>, tours: Collection<string, UserDiscoveryState>}  $context
     * @return array<string, mixed>
     */
    private function present(array $release, ProductRelease $row, User $user, string $surface, int $client, string $language, array $context): array
    {
        $items = [];
        $published = $row->published_at ?? $row->live_since;
        foreach ($release['items'] as $item) {
            $feature = isset($item['feature']) ? $this->registry->feature($item['feature']) : null;
            // An item may name only a feature of this release or of one that is already published.
            if ($feature && $feature['since'] !== $release['key'] && ! $this->isVisible($feature['since'])) {
                continue;
            }
            $access = $feature ? $this->gate->check($user, $feature['requires']) : ['available' => true, 'reason' => null];
            // Features for administrators only are not mentioned to anyone else.
            if ($access['reason'] === 'admin_only') {
                continue;
            }
            $onSurface = ! $feature || in_array($surface, $feature['audiences'], true);
            $canTry = $feature && $access['available'] && $onSurface && $client >= $feature['client_version'];
            $tourId = $feature['tour'] ?? null;
            $tourState = $tourId ? ($context['tours'][$tourId] ?? null) : null;
            $tourDone = $tourState && $tourState->version === ($this->registry->tour($tourId)['version'] ?? 1) && $tourState->completed_at !== null;
            $tried = ($context['features'][$feature['id'] ?? ''] ?? null)?->tried_at !== null;
            $built = [
                'type' => $item['type'], 'title' => Localized::pick($item['title'] ?? $feature['name'], $language), 'body' => Localized::pick($item['body'] ?? $feature['description'], $language),
                'feature' => $feature['id'] ?? null, 'can_try' => $canTry, 'unavailable_reason' => $feature && ! $canTry ? ($access['reason'] ?? ($onSurface ? 'update_required' : 'platform')) : null,
                'tour' => $canTry && $tourId && ! $tourDone ? $tourId : null, 'tried' => $tried,
                'is_new' => $feature && ! $tried && $published && $published->addDays($feature['new_days'])->isFuture(),
                'link' => $item['link'] ?? null,
            ];
            $image = $item['image'] ?? $feature['image'] ?? null;
            if ($image) {
                $built['image'] = ['src' => $image['src'], 'alt' => Localized::pick($image['alt'], $language)];
            }
            $video = $item['video'] ?? $feature['video'] ?? null;
            if ($video) {
                $built['video'] = array_filter(['src' => $video['src'], 'poster' => $video['poster'], 'captions' => $video['captions'] ?? null, 'label' => Localized::pick($video['label'], $language)]);
            }
            $items[] = $built;
        }

        return [
            'key' => $release['key'], 'date' => $release['date'], 'revision' => $release['revision'], 'importance' => $release['importance'],
            'title' => Localized::pick($release['title'], $language), 'summary' => Localized::pick($release['summary'], $language), 'items' => $items,
        ];
    }

    /** @return Collection<string, UserDiscoveryState> this person's states of one kind, keyed by subject key (the current version of each) */
    public function states(User $user, string $type): Collection
    {
        return UserDiscoveryState::where('user_id', $user->id)->where('subject_type', $type)->orderBy('version')->get()->keyBy('subject_key');
    }
}
