<?php

namespace Tests\Feature\Discovery;

use App\Models\UserDiscoveryState;

/** How updates were received: counts for administrators, never anybody's identity. */
class StatsTest extends DiscoveryTestCase
{
    private function released(): void
    {
        $this->write('tours', $this->tour('quick-tour', ['version' => 2]));
        $this->publishable([], ['tour' => 'quick-tour', 'hints' => [['id' => 'qc-hint', 'target' => 'quick-add', 'route' => '/tasks', 'text' => $this->t('Hint')]]]);
        $this->goLive();
    }

    private function state(object $user, string $type, string $key, array $attributes, int $version = 1): void
    {
        UserDiscoveryState::create(['user_id' => $user->id, 'subject_type' => $type, 'subject_key' => $key, 'version' => $version] + $attributes);
    }

    public function test_it_counts_how_the_update_was_received(): void
    {
        $this->released();
        [$a, $b, $c] = [$this->member(), $this->member(), $this->member()];
        $this->state($a, 'release', 'r-one', ['seen_at' => now(), 'dismissed_at' => now(), 'helpful' => true]);
        $this->state($b, 'release', 'r-one', ['seen_at' => now(), 'snoozed_until' => now()->addHours(5), 'helpful' => false]);
        $this->state($c, 'release', 'r-one', ['seen_at' => now()]);
        $this->state($a, 'feature', 'quick-capture', ['tried_at' => now()]);
        $this->state($b, 'feature', 'quick-capture', ['tried_at' => now()]);
        $this->state($a, 'tour', 'quick-tour', ['started_at' => now(), 'completed_at' => now()], 2);
        $this->state($b, 'tour', 'quick-tour', ['started_at' => now(), 'skipped_at' => now()], 2);
        $this->state($c, 'tour', 'quick-tour', ['started_at' => now()], 1);   // an older version of the tour is not counted
        $this->state($a, 'hint', 'qc-hint', ['seen_at' => now(), 'dismissed_at' => now()]);
        $this->state($b, 'hint', 'qc-hint', ['seen_at' => now()]);
        $this->actingAs($this->admin());
        $data = $this->getJson('/api/admin/discovery/stats')->assertOk()->json('data');
        $this->assertSame(4, $data['accounts']);   // three members and the administrator
        $release = $data['releases'][0];
        $this->assertSame('r-one', $release['key']);
        $this->assertSame(['seen' => 3, 'dismissed' => 1, 'snoozed' => 1, 'helpful' => 1, 'unhelpful' => 1], collect($release)->only(['seen', 'dismissed', 'snoozed', 'helpful', 'unhelpful'])->all());
        $feature = $release['features'][0];
        $this->assertSame(['id' => 'quick-capture', 'tried' => 2], collect($feature)->only(['id', 'tried'])->all());
        $this->assertSame(['id' => 'quick-tour', 'version' => 2, 'started' => 2, 'completed' => 1, 'skipped' => 1], $feature['tour']);
        $this->assertSame([['id' => 'qc-hint', 'shown' => 2, 'dismissed' => 1]], $feature['hints']);
    }

    public function test_a_release_nobody_has_seen_counts_zero(): void
    {
        $this->publishable();
        $this->actingAs($this->admin());
        $release = $this->getJson('/api/admin/discovery/stats')->assertOk()->json('data.releases.0');
        $this->assertSame(['seen' => 0, 'dismissed' => 0, 'snoozed' => 0, 'helpful' => 0, 'unhelpful' => 0], collect($release)->only(['seen', 'dismissed', 'snoozed', 'helpful', 'unhelpful'])->all());
        $this->assertNull($release['features'][0]['tour']);
        $this->assertSame(0, $release['features'][0]['tried']);
    }

    public function test_the_answer_holds_counts_only_and_nobodys_identity(): void
    {
        $this->released();
        $person = $this->member(['name' => 'Zainab Example', 'email' => 'zainab@example.test']);
        $this->state($person, 'release', 'r-one', ['seen_at' => now(), 'dismissed_at' => now(), 'helpful' => true, 'surface' => 'mobile']);
        $this->actingAs($this->admin());
        $body = $this->getJson('/api/admin/discovery/stats')->assertOk()->getContent();
        foreach (['Zainab', 'zainab@example.test', 'user_id', 'email', '"name"', 'surface'] as $leak) {
            $this->assertStringNotContainsString($leak, $body, "the statistics must not carry {$leak}");
        }
        $data = json_decode($body, true)['data'];
        array_walk_recursive($data, fn ($v, $k) => $this->assertTrue(is_int($v) || is_string($v) || $v === null, "unexpected value at {$k}"));
    }

    public function test_only_administrators_may_look(): void
    {
        $this->released();
        $this->getJson('/api/admin/discovery/stats')->assertUnauthorized();
        $this->actingAs($this->member());
        $this->getJson('/api/admin/discovery/stats')->assertForbidden()->assertJsonMissingPath('data');
    }

    public function test_reading_the_numbers_needs_no_second_factor(): void
    {
        $this->released();
        $this->actingAs($this->admin(twoFactor: false));
        $this->getJson('/api/admin/discovery/stats')->assertOk();
    }
}
