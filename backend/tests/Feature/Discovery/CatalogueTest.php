<?php

namespace Tests\Feature\Discovery;

use App\Models\UserSetting;
use App\Services\Discovery\ReleaseService;

/** The Discovery Center's list: every feature of live, approved releases for this person, with what they can do with it now. */
class CatalogueTest extends DiscoveryTestCase
{
    private function two(array $first = [], array $second = []): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->write('features', $this->feature('quick-capture', $first + ['tour' => 'quick-tour', 'category' => 'tasks']));
        $this->write('features', $this->feature('night-mode', $second + ['category' => 'settings', 'route' => '/settings', 'name' => $this->t('Night mode')]));
        $this->write('releases', $this->release('r-one', ['items' => [['type' => 'new', 'feature' => 'quick-capture'], ['type' => 'new', 'feature' => 'night-mode']]]));
        $this->goLive();
    }

    public function test_features_are_listed_in_the_persons_language_with_what_they_can_do(): void
    {
        $this->two();
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['language' => 'ar']]);
        $this->actingAs($user);
        $list = $this->getJson('/api/discovery/features')->assertOk()->assertJsonCount(2, 'data')->json('data');
        $byId = collect($list)->keyBy('id');
        $this->assertSame('ar Quick capture', $byId['quick-capture']['name']);
        $this->assertSame('ar Type a phrase', $byId['quick-capture']['description']);
        $this->assertSame('tasks', $byId['quick-capture']['category']);
        $this->assertSame('/tasks', $byId['quick-capture']['route']);
        $this->assertTrue($byId['quick-capture']['can_try']);
        $this->assertSame('quick-tour', $byId['quick-capture']['tour']);
        $this->assertFalse($byId['quick-capture']['tour_done']);
        $this->assertTrue($byId['quick-capture']['is_new']);
        $this->assertNull($byId['night-mode']['tour']);
    }

    public function test_trying_a_feature_clears_new_and_a_finished_tour_stays_available_to_replay(): void
    {
        $this->two();
        $this->actingAs($this->member());
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk();
        $this->putJson('/api/discovery/states/tour/quick-tour', ['action' => 'completed'])->assertOk();
        $one = collect($this->getJson('/api/discovery/features')->json('data'))->firstWhere('id', 'quick-capture');
        $this->assertTrue($one['tried']);
        $this->assertFalse($one['is_new']);
        $this->assertTrue($one['tour_done']);
        $this->assertSame('quick-tour', $one['tour'], 'the tour can be watched again later');
    }

    public function test_what_this_account_cannot_use_says_why_and_is_not_offered(): void
    {
        $this->two(['requires' => ['integration_ready:google']], ['audiences' => ['mobile'], 'client_version' => 3]);
        $this->actingAs($this->member());
        $byId = collect($this->getJson('/api/discovery/features?surface=web&client=1')->json('data'))->keyBy('id');
        $this->assertFalse($byId['quick-capture']['can_try']);
        $this->assertSame('setup_needed', $byId['quick-capture']['unavailable_reason']);
        $this->assertNull($byId['quick-capture']['tour'], 'no tour for what cannot be tried');
        $this->assertSame('platform', $byId['night-mode']['unavailable_reason']);
        $mobile = collect($this->getJson('/api/discovery/features?surface=mobile&client=2')->json('data'))->firstWhere('id', 'night-mode');
        $this->assertSame('update_required', $mobile['unavailable_reason']);
        $ok = collect($this->getJson('/api/discovery/features?surface=mobile&client=3')->json('data'))->firstWhere('id', 'night-mode');
        $this->assertTrue($ok['can_try']);
    }

    public function test_features_for_administrators_do_not_exist_for_anyone_else(): void
    {
        $this->two(['requires' => ['admin']]);
        $this->actingAs($this->member());
        $this->assertSame(['night-mode'], collect($this->getJson('/api/discovery/features')->json('data'))->pluck('id')->all());
        $this->actingAs($this->admin());
        $this->assertCount(2, $this->getJson('/api/discovery/features')->json('data'));
    }

    public function test_nothing_from_a_draft_a_withdrawn_release_or_the_switch_off_and_guests_are_refused(): void
    {
        $this->publishable();
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();   // registered, still a draft
        $this->getJson('/api/discovery/features')->assertUnauthorized();
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/features')->assertOk()->assertExactJson(['data' => []]);
        $this->goLive();
        $this->getJson('/api/discovery/features')->assertOk()->assertJsonCount(1, 'data');
        config(['discovery.auto_activate' => false]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
        $this->getJson('/api/discovery/features')->assertOk()->assertExactJson(['data' => []]);
    }

    public function test_the_newest_release_comes_first(): void
    {
        $this->write('features', $this->feature('old-one', ['since' => 'r-old', 'name' => $this->t('Old')]));
        $this->write('features', $this->feature('new-one', ['since' => 'r-new', 'name' => $this->t('New')]));
        $this->write('releases', $this->release('r-old', ['date' => '2026-10-01', 'items' => [['type' => 'new', 'feature' => 'old-one']]]));
        $this->write('releases', $this->release('r-new', ['date' => '2026-11-01', 'items' => [['type' => 'new', 'feature' => 'new-one']]]));
        $this->goLive('r-old');
        $this->goLive('r-new');
        $this->actingAs($this->member());
        $this->assertSame(['new-one', 'old-one'], collect($this->getJson('/api/discovery/features')->json('data'))->pluck('id')->all());
    }
}
