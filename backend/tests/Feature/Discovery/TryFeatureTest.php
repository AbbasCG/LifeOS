<?php

namespace Tests\Feature\Discovery;

use App\Models\UserDiscoveryState;

/** "Try now": the server checks availability, picks the route from the reviewed content, and remembers the first try. */
class TryFeatureTest extends DiscoveryTestCase
{
    public function test_an_available_feature_answers_with_its_route_and_records_the_first_try(): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->publishable([], ['tour' => 'quick-tour', 'route' => '/tasks?add=task']);
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk()->assertExactJson(['data' => ['available' => true, 'reason' => null, 'route' => '/tasks?add=task', 'tour' => 'quick-tour']]);
        $first = UserDiscoveryState::where(['user_id' => $user->id, 'subject_type' => 'feature', 'subject_key' => 'quick-capture'])->firstOrFail()->tried_at;
        $this->assertNotNull($first);
        $this->travel(1)->hour();
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk();
        $this->assertEquals($first, UserDiscoveryState::first()->tried_at, 'the first try is kept');
    }

    public function test_the_route_comes_from_the_content_not_from_the_request(): void
    {
        $this->publishable();
        $this->goLive();
        $this->actingAs($this->member());
        $this->postJson('/api/discovery/features/quick-capture/try', ['route' => 'https://evil.example', 'surface' => 'web'])->assertOk()->assertJsonPath('data.route', '/tasks');
    }

    public function test_a_finished_tour_is_not_offered_again(): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->publishable([], ['tour' => 'quick-tour']);
        $this->goLive();
        $this->actingAs($this->member());
        $this->putJson('/api/discovery/states/tour/quick-tour', ['action' => 'completed'])->assertOk();
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk()->assertJsonPath('data.tour', null)->assertJsonPath('data.available', true);
    }

    public function test_a_feature_this_account_cannot_use_gets_no_route_and_no_record(): void
    {
        $this->publishable([], ['requires' => ['integration_ready:google']]);
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk()->assertExactJson(['data' => ['available' => false, 'reason' => 'setup_needed', 'route' => null, 'tour' => null]]);
        $this->assertSame(0, UserDiscoveryState::where('user_id', $user->id)->count());
    }

    public function test_a_feature_for_another_platform_or_a_newer_client_is_not_available_yet(): void
    {
        $this->publishable([], ['audiences' => ['mobile'], 'client_version' => 4]);
        $this->goLive();
        $this->actingAs($this->member());
        $this->postJson('/api/discovery/features/quick-capture/try?surface=web&client=9')->assertOk()->assertJsonPath('data.reason', 'platform');
        $this->postJson('/api/discovery/features/quick-capture/try?surface=mobile&client=3')->assertOk()->assertJsonPath('data.reason', 'update_required');
        $this->postJson('/api/discovery/features/quick-capture/try?surface=mobile&client=4')->assertOk()->assertJsonPath('data.available', true);
    }

    public function test_an_administrator_only_feature_does_not_exist_for_everyone_else(): void
    {
        $this->publishable([], ['requires' => ['admin']]);
        $this->goLive();
        $this->actingAs($this->member());
        $this->postJson('/api/discovery/features/quick-capture/try')->assertNotFound();
        $this->actingAs($this->admin(false)->forceFill(['created_at' => now()->subDays(3)]));
        $this->postJson('/api/discovery/features/quick-capture/try')->assertOk()->assertJsonPath('data.available', true);
    }

    public function test_a_feature_of_a_release_that_is_not_published_cannot_be_tried(): void
    {
        $this->publishable();
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();   // a draft
        $this->actingAs($this->member());
        $this->postJson('/api/discovery/features/quick-capture/try')->assertNotFound();
        $this->postJson('/api/discovery/features/no-such-feature/try')->assertNotFound();
        $this->postJson('/api/discovery/features/Bad_ID/try')->assertNotFound();
    }
}
