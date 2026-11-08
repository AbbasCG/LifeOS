<?php

namespace App\Services\Discovery;

use App\Models\DiscoveryTester;
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
 *
 * Staged rollout: an approved, live release is shown to the people its `rollout` stage names (administrators only, administrators and test accounts, or
 * everyone). The stage is enforced here, on the server, for every answer about a person (announcement, history, tips, the Discovery Center, tours, states,
 * "Try now") and therefore also for the notification, which is only ever sent for an announcement that person was about to be shown.
 */
class ReleaseService
{
    /** @var Collection<string, ProductRelease>|null */
    private ?Collection $visible = null;

    /** @var array<int, bool> whether an account is a test account, per request */
    private array $testers = [];

    public function __construct(private DiscoveryRegistry $registry, private FeatureGate $gate, private DeployConfirmation $deploy, private Notifier $notifier) {}

    // ---- activation (scheduled; a no-op unless a healthy deploy is confirmed) ----

    /**
     * @return array{status: string, detail: string, registered: list<string>, updated: list<string>, absent: list<string>, needs_review: list<string>}
     */
    public function reconcile(bool $dryRun = false): array
    {
        $state = $this->deploy->inspect();
        $result = ['status' => $state['status'], 'detail' => $state['detail'], 'registered' => [], 'updated' => [], 'absent' => [], 'needs_review' => [], 'approved' => []];
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
        $auto = (bool) config('discovery.auto_approve');
        foreach ($releases as $key => $release) {
            $row = $rows[$key] ?? null;
            if (! $row) {
                $result['registered'][] = $key;
                if ($auto) {
                    $result['approved'][] = $key;
                }
                if (! $dryRun) {
                    $created = ProductRelease::create(['key' => $key, 'revision' => $release['revision'], 'importance' => $release['importance'], 'review_status' => ProductRelease::DRAFT,
                        'rollout' => $this->defaultRollout(), 'content_hash' => $this->registry->fingerprint($key), 'deploy_status' => ProductRelease::LIVE, 'deployed_sha' => $sha, 'live_since' => $now, 'last_confirmed_at' => $now]);
                    if ($auto) {
                        $this->autoApprove($created);
                    }
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
            // Still a draft (new text, or text edited after an approval): approved automatically. A withdrawn release is an administrator's decision and stays withdrawn.
            $draft = $revised || $row->review_status === ProductRelease::DRAFT;
            if ($auto && $draft) {
                $result['approved'][] = $key;
            }
            if (! $dryRun) {
                $row->forceFill(['deploy_status' => ProductRelease::LIVE, 'absent_since' => null, 'revision' => $release['revision'], 'importance' => $release['importance'], 'deployed_sha' => $sha,
                    'content_hash' => $hash, 'last_confirmed_at' => $now] + ($revised ? ['review_status' => ProductRelease::DRAFT] : []))->save();
                if ($auto && $draft) {
                    $this->autoApprove($row);
                }
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

    // ---- staged rollout ----

    private function defaultRollout(): string
    {
        $stage = (string) config('discovery.default_rollout', ProductRelease::ROLLOUT_GENERAL);

        return in_array($stage, ProductRelease::ROLLOUTS, true) ? $stage : ProductRelease::ROLLOUT_GENERAL;
    }

    /** Whether the stage of this release includes this person. An unknown stage reaches nobody (fails closed). */
    public function reaches(ProductRelease $row, User $user): bool
    {
        return match ($row->rollout) {
            ProductRelease::ROLLOUT_GENERAL => true,
            ProductRelease::ROLLOUT_INTERNAL => (bool) $user->is_admin || $this->isTester($user),
            ProductRelease::ROLLOUT_ADMIN => (bool) $user->is_admin,
            default => false,
        };
    }

    public function isTester(User $user): bool
    {
        return $this->testers[$user->id] ??= DiscoveryTester::where('user_id', $user->id)->exists();
    }

    /** Changes who may see a release. Allowed for any release the running code contains; it takes effect at once and needs no deploy. */
    public function setRollout(string $key, string $stage): ProductRelease
    {
        if (! in_array($stage, ProductRelease::ROLLOUTS, true)) {
            throw new ReleaseStateException('rollout_unknown', 'Unknown stage.', 422);
        }
        $row = ProductRelease::where('key', $key)->first() ?? throw new ReleaseStateException('release_unknown', 'No such release.', 404);
        $row->forceFill(['rollout' => $stage])->save();
        $this->visible = null;

        return $row;
    }

    /** @return list<string> the reasons this release is not shown to people now (empty when it is), for the administrator screen */
    private function blockers(string $key, ?ProductRelease $row): array
    {
        $out = [];
        if (! config('discovery.auto_activate')) {
            $out[] = 'activation_off';
        }
        if (! $row) {
            return [...$out, 'not_registered'];
        }
        if ($row->deploy_status !== ProductRelease::LIVE) {
            $out[] = 'not_live';
        }
        if ($row->review_status === ProductRelease::WITHDRAWN) {
            $out[] = 'withdrawn';
        } elseif ($row->review_status !== ProductRelease::APPROVED) {
            $out[] = 'not_approved';
        } elseif ($row->approved_hash === null || ! hash_equals($row->approved_hash, (string) $this->registry->fingerprint($key))) {
            $out[] = 'content_changed';
        }

        return $out;
    }

    // ---- administrator decisions ----

    /**
     * The approval a healthy deploy grants by itself (DISCOVERY_AUTO_APPROVE): the same record an administrator's click leaves, bound to the fingerprint of the text now in the
     * code, with nobody as reviewer. Only a release that is live in a confirmed deploy gets here (reconcile returns earlier otherwise).
     */
    private function autoApprove(ProductRelease $row): void
    {
        $hash = $this->registry->fingerprint($row->key);
        if ($hash === null || $row->review_status === ProductRelease::WITHDRAWN) {
            return;
        }
        $row->forceFill(['approved_hash' => $hash, 'content_hash' => $hash, 'published_at' => $row->published_at ?? now()]);
        $this->review($row, ProductRelease::APPROVED, null);
    }

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

    private function review(ProductRelease $row, string $status, ?User $admin): ProductRelease
    {
        $row->forceFill(['review_status' => $status, 'reviewed_by' => $admin?->id, 'reviewed_at' => now()])->save();
        $this->visible = null;

        return $row;
    }

    /**
     * The exact text an administrator approves, in all three languages: the release (title, summary, items), the features and the tour steps. It comes from the same
     * scope as the fingerprint, so what is shown here and what is approved cannot differ.
     *
     * @return array<string, mixed>
     */
    private function preview(string $key): array
    {
        $scope = $this->registry->scope($key);
        $release = $scope['release'];

        return [
            'title' => $release['title'], 'summary' => $release['summary'], 'audiences' => $release['audiences'],
            'items' => array_map(fn (array $i) => array_filter(['type' => $i['type'], 'feature' => $i['feature'] ?? null, 'title' => $i['title'] ?? null, 'body' => $i['body'] ?? null, 'link' => $i['link'] ?? null]), $release['items']),
            'features' => array_map(fn (array $f) => ['id' => $f['id'], 'category' => $f['category'], 'name' => $f['name'], 'description' => $f['description'], 'route' => $f['route'], 'requires' => $f['requires'], 'tour' => $f['tour']], $scope['features']),
            'tours' => array_values(array_map(fn (array $t) => ['id' => $t['id'], 'title' => $t['title'], 'steps' => array_map(fn (array $s) => ['target' => $s['target'], 'title' => $s['title'], 'body' => $s['body']], $t['steps'])], $scope['tours'])),
        ];
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
                'content_hash' => $this->registry->fingerprint($key), 'approved_hash' => $row?->approved_hash, 'preview' => $this->preview($key),
                'rollout' => $row?->rollout ?? $this->defaultRollout(), 'blockers' => $this->blockers($key, $row),
                'live_since' => $row?->live_since?->toIso8601String(), 'reviewed_at' => $row?->reviewed_at?->toIso8601String(), 'visible' => (bool) $row?->isVisible(),
                'auto_approved' => $row !== null && $row->review_status === ProductRelease::APPROVED && $row->reviewed_by === null];
        }

        return $out;
    }

    // ---- what a person sees ----

    /** @return Collection<string, ProductRelease> the rows this person may see: approved, live, content unchanged since approval, and their stage includes them */
    public function visibleRows(User $user): Collection
    {
        return $this->approvedRows()->filter(fn (ProductRelease $row) => $this->reaches($row, $user));
    }

    /** @return Collection<string, ProductRelease> approved and live rows whose content is present and unchanged since it was approved, whoever may see them */
    private function approvedRows(): Collection
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

    public function isVisible(string $key, User $user): bool
    {
        return $this->visibleRows($user)->has($key);
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
        foreach ($this->visibleRows($user) as $key => $row) {
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
        foreach ($this->visibleRows($user) as $key => $row) {
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
            if ($feature && $feature['since'] !== $release['key'] && ! $this->isVisible($feature['since'], $user)) {
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
            $built += $this->media($item['image'] ?? $feature['image'] ?? null, $item['video'] ?? $feature['video'] ?? null, $language);
            $items[] = $built;
        }

        return [
            'key' => $release['key'], 'date' => $release['date'], 'revision' => $release['revision'], 'importance' => $release['importance'],
            'title' => Localized::pick($release['title'], $language), 'summary' => Localized::pick($release['summary'], $language), 'items' => $items,
        ];
    }

    /**
     * Feature discovery for this person: the features that are still new to them (for "New" badges) and the contextual hints that
     * are due. A hint is due once: a seen or dismissed hint never returns. Nothing is returned for features of unpublished releases,
     * for administrators only, for another surface, or for a tab too old to have the screen; hints are empty when the person turned them off.
     *
     * @return array{new: list<array<string, mixed>>, hints: list<array<string, mixed>>}
     */
    public function guide(User $user, string $surface, int $client): array
    {
        $language = Localized::of($user->preferences());
        $features = $this->states($user, 'feature');
        $hints = $this->states($user, 'hint');
        $hintsOn = (bool) (($user->preferences()['discovery']['hints_enabled'] ?? true));
        $new = [];
        $due = [];
        foreach ($this->visibleRows($user) as $key => $row) {
            $published = $row->published_at ?? $row->live_since;
            foreach ($this->registry->features() as $feature) {
                if ($feature['since'] !== $key || ! in_array($surface, $feature['audiences'], true) || $client < $feature['client_version']) {
                    continue;
                }
                if (! $this->gate->check($user, $feature['requires'])['available']) {
                    continue;
                }
                $state = $features[$feature['id']] ?? null;
                if ($published && ! $state?->tried_at && $published->addDays($feature['new_days'])->isFuture()) {
                    $new[] = ['id' => $feature['id'], 'route' => $feature['route'], 'name' => Localized::pick($feature['name'], $language)];
                }
                if (! $hintsOn) {
                    continue;
                }
                foreach ($feature['hints'] as $hint) {
                    $seen = $hints[$hint['id']] ?? null;
                    if ($seen?->seen_at || $seen?->dismissed_at) {
                        continue;
                    }
                    $due[] = ['id' => $hint['id'], 'feature' => $feature['id'], 'target' => $hint['target'], 'route' => $hint['route'], 'text' => Localized::pick($hint['text'], $language)];
                }
            }
        }

        return ['new' => $new, 'hints' => $due];
    }

    /**
     * The image and video of an item or feature, in the person's language (alternative texts and labels).
     *
     * @param  array<string, mixed>|null  $image
     * @param  array<string, mixed>|null  $video
     * @return array<string, mixed>
     */
    private function media(?array $image, ?array $video, string $language): array
    {
        $out = [];
        if ($image) {
            $out['image'] = ['src' => $image['src'], 'alt' => Localized::pick($image['alt'], $language)];
        }
        if ($video) {
            $out['video'] = array_filter(['src' => $video['src'], 'poster' => $video['poster'], 'captions' => $video['captions'] ?? null, 'label' => Localized::pick($video['label'], $language)]);
        }

        return $out;
    }

    /**
     * Everything this person can discover: the features of live, approved releases, newest release first, each with what they can do with it now (try it,
     * replay its tour) and why not when they cannot. Features for administrators only do not exist for anyone else. Nothing from a draft, a withdrawn or an
     * unapproved release, whatever the request says.
     *
     * @return list<array<string, mixed>>
     */
    public function catalogue(User $user, string $surface, int $client): array
    {
        $language = Localized::of($user->preferences());
        $features = $this->states($user, 'feature');
        $tours = $this->states($user, 'tour');
        $rows = [];
        foreach ($this->visibleRows($user) as $key => $row) {
            $published = $row->published_at ?? $row->live_since;
            foreach ($this->registry->features() as $feature) {
                if ($feature['since'] !== $key) {
                    continue;
                }
                $access = $this->gate->check($user, $feature['requires']);
                if ($access['reason'] === 'admin_only') {
                    continue;
                }
                $onSurface = in_array($surface, $feature['audiences'], true);
                $canTry = $access['available'] && $onSurface && $client >= $feature['client_version'];
                $tourId = $feature['tour'];
                $tourState = $tourId ? ($tours[$tourId] ?? null) : null;
                $tried = ($features[$feature['id']] ?? null)?->tried_at !== null;
                $rows[] = [
                    'date' => $this->registry->release($key)['date'],
                    'feature' => [
                        'id' => $feature['id'], 'category' => $feature['category'], 'name' => Localized::pick($feature['name'], $language), 'description' => Localized::pick($feature['description'], $language),
                        'route' => $feature['route'], 'release' => $key, 'date' => $this->registry->release($key)['date'],
                        'can_try' => $canTry, 'unavailable_reason' => $canTry ? null : ($access['reason'] ?? ($onSurface ? 'update_required' : 'platform')),
                        'tour' => $canTry ? $tourId : null,
                        'tour_done' => (bool) ($tourState && $tourState->version === ($this->registry->tour($tourId)['version'] ?? 1) && $tourState->completed_at !== null),
                        'tried' => $tried, 'is_new' => ! $tried && $published && $published->addDays($feature['new_days'])->isFuture(),
                    ] + $this->media($feature['image'] ?? null, $feature['video'] ?? null, $language),
                ];
            }
        }
        usort($rows, fn (array $a, array $b) => [$b['date'], $a['feature']['category'], $a['feature']['name']] <=> [$a['date'], $b['feature']['category'], $b['feature']['name']]);

        return array_map(fn (array $r) => $r['feature'], $rows);
    }

    /** @return Collection<string, UserDiscoveryState> this person's states of one kind, keyed by subject key (the current version of each) */
    public function states(User $user, string $type): Collection
    {
        return UserDiscoveryState::where('user_id', $user->id)->where('subject_type', $type)->orderBy('version')->get()->keyBy('subject_key');
    }
}
