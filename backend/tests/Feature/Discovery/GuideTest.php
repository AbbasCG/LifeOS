<?php

namespace Tests\Feature\Discovery;

use App\Models\ProductRelease;
use App\Models\UserSetting;
use App\Services\Discovery\ReleaseService;

/** Feature discovery: "New" badges and contextual hints, only for what is live, reachable and not yet seen. */
class GuideTest extends DiscoveryTestCase
{
    private const HINT = ['id' => 'capture-hint', 'target' => 'quick-add', 'route' => '/tasks', 'text' => ['ar' => 'ar hint', 'nl' => 'nl hint', 'en' => 'en hint']];

    private function live(array $feature = []): void
    {
        $this->publishable([], $feature + ['hints' => [self::HINT]]);
        $this->goLive();
    }

    public function test_a_new_feature_and_its_hint_are_offered_in_the_persons_language(): void
    {
        $this->live();
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['language' => 'nl']]);
        $this->actingAs($user);
        $this->getJson('/api/discovery/guide')->assertOk()
            ->assertJsonPath('data.new.0.id', 'quick-capture')->assertJsonPath('data.new.0.route', '/tasks')
            ->assertJsonPath('data.hints.0.id', 'capture-hint')->assertJsonPath('data.hints.0.text', 'nl hint')->assertJsonPath('data.hints.0.target', 'quick-add');
    }

    public function test_trying_the_feature_clears_its_badge_but_not_its_hint(): void
    {
        $this->live();
        $this->actingAs($this->member());
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk();
        $this->getJson('/api/discovery/guide')->assertOk()->assertJsonCount(0, 'data.new')->assertJsonCount(1, 'data.hints');
    }

    public function test_a_hint_is_never_repeated_once_seen_or_dismissed(): void
    {
        $this->live();
        $this->actingAs($this->member());
        $this->putJson('/api/discovery/states/hint/capture-hint', ['action' => 'seen'])->assertOk();
        $this->getJson('/api/discovery/guide')->assertOk()->assertJsonCount(0, 'data.hints');
    }

    public function test_a_badge_expires_after_new_days(): void
    {
        $this->live(['new_days' => 3]);
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/guide')->assertJsonCount(1, 'data.new');
        $this->travel(4)->days();
        $this->getJson('/api/discovery/guide')->assertJsonCount(0, 'data.new');
    }

    public function test_turning_hints_off_removes_hints_but_keeps_badges(): void
    {
        $this->live();
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['discovery' => ['hints_enabled' => false]]]);
        $this->actingAs($user);
        $this->getJson('/api/discovery/guide')->assertOk()->assertJsonCount(0, 'data.hints')->assertJsonCount(1, 'data.new');
    }

    public function test_nothing_is_offered_before_approval_or_on_the_wrong_surface_or_for_an_old_tab(): void
    {
        $this->publishable([], ['hints' => [self::HINT], 'audiences' => ['mobile'], 'client_version' => 2]);
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/guide')->assertOk()->assertExactJson(['data' => ['new' => [], 'hints' => []]]);
        $this->goLive();
        $this->getJson('/api/discovery/guide?surface=web&client=9')->assertJsonCount(0, 'data.hints');
        $this->getJson('/api/discovery/guide?surface=mobile&client=1')->assertJsonCount(0, 'data.hints');
        $this->getJson('/api/discovery/guide?surface=mobile&client=2')->assertJsonCount(1, 'data.hints');
    }

    public function test_features_this_account_cannot_use_are_not_advertised(): void
    {
        $this->live(['requires' => ['integration_ready:google']]);
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/guide')->assertOk()->assertExactJson(['data' => ['new' => [], 'hints' => []]]);
    }

    public function test_the_switch_off_shows_nothing_and_guests_are_refused(): void
    {
        $this->live();
        $this->getJson('/api/discovery/guide')->assertUnauthorized();
        $this->actingAs($this->member());
        config(['discovery.auto_activate' => false]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
        $this->getJson('/api/discovery/guide')->assertOk()->assertExactJson(['data' => ['new' => [], 'hints' => []]]);
        $this->assertSame(1, ProductRelease::count());
    }
}
