<?php

namespace Tests\Feature\Discovery;

use App\Models\InboxNotification;
use App\Models\ProductRelease;
use App\Models\User;
use App\Models\UserDiscoveryState;
use App\Models\UserSetting;
use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\ReleaseService;
use App\Services\Notifier;
use Illuminate\Testing\TestResponse;

/** What a person is shown, and that it is shown once. */
class AnnouncementTest extends DiscoveryTestCase
{
    private function bootstrap(array $query = []): TestResponse
    {
        return $this->getJson('/api/discovery/bootstrap'.($query ? '?'.http_build_query($query) : ''));
    }

    public function test_guests_cannot_read_discovery_data(): void
    {
        $this->getJson('/api/discovery/bootstrap')->assertUnauthorized();
        $this->getJson('/api/discovery/releases')->assertUnauthorized();
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'seen'])->assertUnauthorized();
        $this->postJson('/api/discovery/features/quick-capture/try')->assertUnauthorized();
    }

    public function test_with_the_shipped_content_nothing_is_shown_until_it_is_approved(): void
    {
        $this->app->singleton(DiscoveryRegistry::class, fn () => new DiscoveryRegistry(resource_path('discovery')));
        $this->actingAs($this->member());
        $this->bootstrap()->assertOk()->assertJsonPath('data.announcement', null)->assertJsonPath('data.counts.unseen_updates', 0);
        $this->getJson('/api/discovery/releases')->assertOk()->assertJsonPath('data', []);
    }

    public function test_a_draft_a_withdrawn_or_an_absent_release_is_never_shown(): void
    {
        $this->publishable();
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();   // registered, still a draft
        $this->actingAs($this->member());
        $this->bootstrap()->assertOk()->assertJsonPath('data.announcement', null);
        $this->getJson('/api/discovery/releases')->assertOk()->assertJsonPath('data', []);

        foreach (['withdrawn' => ['review_status' => 'withdrawn'], 'absent' => ['review_status' => 'approved', 'deploy_status' => 'absent']] as $case => $state) {
            ProductRelease::query()->update($state);
            $this->bootstrap()->assertOk()->assertJsonPath('data.announcement', null);
            $this->getJson('/api/discovery/releases')->assertOk()->assertJsonPath('data', []);
        }
    }

    public function test_an_approved_live_release_is_shown_with_its_text_in_the_persons_language(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->bootstrap()->assertOk()->assertJsonPath('data.announcement.key', 'r-one')->assertJsonPath('data.announcement.title', 'en Title')
            ->assertJsonPath('data.announcement.items.0.title', 'en Quick capture')->assertJsonPath('data.announcement.items.0.body', 'en Type a phrase')
            ->assertJsonPath('data.announcement.items.0.can_try', true)->assertJsonPath('data.counts.unseen_updates', 1);

        UserSetting::create(['user_id' => $user->id, 'preferences' => ['language' => 'ar']]);
        $this->bootstrap()->assertJsonPath('data.announcement.title', 'ar Title');
        UserSetting::where('user_id', $user->id)->update(['preferences' => json_encode(['language' => 'nl'])]);
        $this->bootstrap()->assertJsonPath('data.announcement.title', 'nl Title');
        UserSetting::where('user_id', $user->id)->update(['preferences' => json_encode(['language' => 'fr'])]);
        $this->bootstrap()->assertJsonPath('data.announcement.title', 'en Title');
    }

    public function test_the_platform_decides_who_is_the_audience(): void
    {
        $this->publishable(['audiences' => ['mobile']]);
        $this->goLive();
        $this->actingAs($this->member());
        $this->bootstrap(['surface' => 'web'])->assertJsonPath('data.announcement', null);
        $this->getJson('/api/discovery/releases?surface=web')->assertJsonPath('data', []);
        $this->bootstrap(['surface' => 'mobile'])->assertJsonPath('data.announcement.key', 'r-one');
        $this->getJson('/api/discovery/releases?surface=mobile')->assertJsonCount(1, 'data');
        $this->bootstrap(['surface' => 'desktop'])->assertUnprocessable();
    }

    public function test_someone_who_joined_after_the_release_went_live_does_not_get_it_as_news_but_can_read_it_in_the_history(): void
    {
        $this->publishable();
        $this->goLive();
        $newcomer = User::factory()->create(['created_at' => now()->addMinute()]);
        $this->actingAs($newcomer);
        $this->bootstrap()->assertJsonPath('data.announcement', null)->assertJsonPath('data.counts.unseen_updates', 0);
        $this->getJson('/api/discovery/releases')->assertJsonCount(1, 'data');
    }

    public function test_it_is_shown_once_and_never_again_after_it_was_seen_or_dismissed(): void
    {
        $this->publishable();
        $this->goLive();
        $this->actingAs($this->member());
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');   // not seen yet: still waiting
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'seen'])->assertOk();
        $this->bootstrap()->assertJsonPath('data.announcement', null)->assertJsonPath('data.counts.unseen_updates', 0);
        $this->getJson('/api/discovery/releases')->assertJsonPath('data.0.seen', true);
    }

    public function test_later_hides_it_for_a_day_then_it_returns_and_after_two_postponements_it_stays_in_the_history(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'snoozed'])->assertOk();
        $this->bootstrap()->assertJsonPath('data.announcement', null);
        $this->travel(23)->hours();
        $this->bootstrap()->assertJsonPath('data.announcement', null);
        $this->travel(2)->hours();
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'seen'])->assertOk();   // shown again: the postponement is over
        $this->bootstrap()->assertJsonPath('data.announcement', null);

        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'snoozed'])->assertOk()->assertJsonPath('data.dismissed_at', null);
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'snoozed'])->assertOk()->assertJsonPath('data.dismissed_at', null);   // a second tap during the same postponement counts once
        $this->travel(25)->hours();
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'seen'])->assertOk();
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'snoozed'])->assertOk()->assertJsonPath('data.dismissed_at', fn ($v) => $v !== null);
        $this->travel(5)->days();
        $this->bootstrap()->assertJsonPath('data.announcement', null);
        $this->getJson('/api/discovery/releases')->assertJsonCount(1, 'data');
    }

    public function test_state_belongs_to_the_person_who_made_it(): void
    {
        $this->publishable();
        $this->goLive();
        $alice = $this->member();
        $bob = $this->member();
        $this->actingAs($alice)->putJson('/api/discovery/states/release/r-one', ['action' => 'dismissed'])->assertOk();
        $this->actingAs($bob)->getJson('/api/discovery/bootstrap')->assertJsonPath('data.announcement.key', 'r-one');
        $this->assertSame(1, UserDiscoveryState::where('user_id', $alice->id)->whereNotNull('dismissed_at')->count());
        $this->assertSame(0, UserDiscoveryState::where('user_id', $bob->id)->whereNotNull('dismissed_at')->count());
    }

    public function test_an_old_client_is_asked_to_reload_instead_of_being_promised_what_it_cannot_show(): void
    {
        $this->publishable([], ['client_version' => 3]);
        $this->goLive();
        $this->actingAs($this->member());
        $this->bootstrap(['client' => 2])->assertJsonPath('data.announcement', null)->assertJsonPath('data.update_required', true)->assertJsonPath('data.counts.unseen_updates', 0);
        $this->bootstrap(['client' => 3])->assertJsonPath('data.announcement.key', 'r-one')->assertJsonPath('data.update_required', false);
    }

    public function test_a_feature_for_administrators_is_not_mentioned_to_anyone_else(): void
    {
        $this->write('features', $this->feature('admin-tool', ['requires' => ['admin']]));
        $this->write('releases', $this->release('r-one', ['items' => [['type' => 'new', 'feature' => 'quick-capture'], ['type' => 'new', 'feature' => 'admin-tool']]]));
        $this->write('features', $this->feature('quick-capture'));
        $this->goLive();
        $this->actingAs($this->member());
        $this->bootstrap()->assertJsonCount(1, 'data.announcement.items');
        $this->actingAs($this->admin(false)->forceFill(['created_at' => now()->subDays(9)]));
        $this->bootstrap()->assertJsonCount(2, 'data.announcement.items');
    }

    public function test_an_item_for_a_feature_this_account_cannot_use_has_no_try_button(): void
    {
        $this->publishable([], ['requires' => ['integration_ready:google']]);
        $this->goLive();
        $this->actingAs($this->member());
        $this->bootstrap()->assertJsonPath('data.announcement.items.0.can_try', false)->assertJsonPath('data.announcement.items.0.unavailable_reason', 'setup_needed')->assertJsonPath('data.announcement.items.0.tour', null);
    }

    public function test_a_tour_is_offered_only_while_it_is_not_finished(): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->publishable([], ['tour' => 'quick-tour']);
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->bootstrap()->assertJsonPath('data.announcement.items.0.tour', 'quick-tour');
        $this->putJson('/api/discovery/states/tour/quick-tour', ['action' => 'completed'])->assertOk();
        $this->getJson('/api/discovery/releases')->assertJsonPath('data.0.items.0.tour', null);
    }

    public function test_an_important_release_sends_one_notification_per_person_however_often_the_app_opens(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        foreach (range(1, 4) as $_) {
            $this->bootstrap()->assertOk();
        }
        $notes = InboxNotification::where('user_id', $user->id)->get();
        $this->assertCount(1, $notes);
        $this->assertSame('updates', $notes[0]->category);
        $this->assertSame('release', $notes[0]->kind);
        $this->assertSame('en Title', $notes[0]->title);
        $this->assertSame('/updates?release=r-one', $notes[0]->link);
        $this->assertSame('release:r-one:'.$user->id, $notes[0]->deduplication_key);
        // Dismissing and a later app start do not create another.
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'dismissed']);
        $this->bootstrap();
        $this->assertSame(1, InboxNotification::where('user_id', $user->id)->count());
    }

    public function test_a_normal_release_sends_no_notification(): void
    {
        $this->publishable(['importance' => 'normal']);
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $this->assertSame(0, InboxNotification::where('user_id', $user->id)->count());
    }

    public function test_the_updates_category_can_be_switched_off_and_is_then_respected(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['notification_channels' => ['updates' => ['enabled' => false]]]]);
        $this->actingAs($user);
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $this->assertSame(0, InboxNotification::where('user_id', $user->id)->count());
        $this->getJson('/api/settings')->assertOk();
    }

    public function test_notifications_off_for_the_account_means_no_update_notification(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['notifications' => false]]);
        $this->actingAs($user);
        $this->bootstrap()->assertOk();
        $this->assertSame(0, InboxNotification::where('user_id', $user->id)->count());
    }

    public function test_quiet_hours_postpone_the_notification_rather_than_lose_it(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        $this->travelTo(now()->utc()->setTime(23, 0));
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['timezone' => 'UTC', 'quiet_start' => '22:00', 'quiet_end' => '07:00']]);
        $this->actingAs($user);
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $this->assertSame(0, InboxNotification::where('user_id', $user->id)->count(), 'quiet hours: no notification yet');
        $this->travelTo(now()->utc()->addDay()->setTime(8, 0));
        $this->bootstrap()->assertOk();
        $this->bootstrap()->assertOk();
        $this->assertSame(1, InboxNotification::where('user_id', $user->id)->count(), 'created once, after the quiet period');
    }

    public function test_the_notification_settings_the_screen_sends_back_can_be_saved_and_switch_updates_off(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        // Exactly what the Notifications screen does: read every category, change one, save the whole object.
        $channels = $this->getJson('/api/push/config')->assertOk()->json('channels');
        $this->assertArrayHasKey('updates', $channels);
        $this->assertTrue($channels['updates']['enabled']);
        $this->assertFalse($channels['updates']['push'], 'push is off by default for product updates');
        $channels['updates']['enabled'] = false;
        $this->putJson('/api/settings', ['notification_channels' => $channels])->assertOk();
        $this->assertFalse($this->getJson('/api/push/config')->json('channels.updates.enabled'));
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $this->assertSame(0, InboxNotification::where('user_id', $user->id)->count());
    }

    public function test_a_deleted_notification_does_not_come_back_but_one_held_back_is_tried_again(): void
    {
        $this->publishable();
        $this->goLive();
        $user = $this->member();
        $this->actingAs($user);
        $this->bootstrap()->assertOk();
        $note = InboxNotification::where('user_id', $user->id)->firstOrFail();
        $this->deleteJson('/api/notifications/'.$note->id)->assertOk();
        $this->bootstrap()->assertOk();
        $this->assertSame(0, InboxNotification::where('user_id', $user->id)->count(), 'deleting it is respected');
        $this->assertNotNull(UserDiscoveryState::where(['user_id' => $user->id, 'subject_key' => 'r-one'])->value('notified_at'));
    }

    public function test_a_failing_notification_never_stops_the_app_from_opening(): void
    {
        $this->publishable();
        $this->goLive();
        $this->mock(Notifier::class, fn ($mock) => $mock->shouldReceive('send')->andThrow(new \RuntimeException('database is busy')));
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
        $this->actingAs($this->member());
        $this->bootstrap()->assertOk()->assertJsonPath('data.announcement.key', 'r-one');
    }

    public function test_someone_who_joined_before_it_was_published_still_gets_it_even_if_approval_took_days(): void
    {
        $this->publishable();
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $registeredAt = now();
        $between = User::factory()->create(['created_at' => $registeredAt->copy()->addHour()]);   // joined after the deploy, before the approval
        $this->travel(3)->days();
        ProductRelease::where('key', 'r-one')->update(['review_status' => 'approved', 'approved_hash' => $this->hash(), 'content_hash' => $this->hash(), 'published_at' => now()]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
        $this->actingAs($between);
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-one');
        $after = User::factory()->create(['created_at' => now()->addMinute()]);
        $this->actingAs($after)->getJson('/api/discovery/bootstrap')->assertJsonPath('data.announcement', null);
    }

    public function test_an_item_cannot_show_a_feature_of_a_release_that_is_not_published(): void
    {
        $this->write('features', $this->feature('quick-capture', ['since' => 'r-old']));
        $this->write('features', $this->feature('hidden-gem', ['since' => 'r-new']));
        $this->write('releases', $this->release('r-old', ['date' => '2026-10-01', 'items' => [['type' => 'new', 'feature' => 'quick-capture']]]));
        $this->write('releases', $this->release('r-new', ['date' => '2026-11-08', 'items' => [['type' => 'new', 'feature' => 'hidden-gem']]]));
        $this->goLive('r-old');   // r-new is registered by the same reconcile, but stays a draft
        $this->actingAs($this->member());
        $this->bootstrap()->assertJsonPath('data.announcement.key', 'r-old')->assertJsonCount(1, 'data.announcement.items')->assertJsonPath('data.announcement.items.0.feature', 'quick-capture');
    }

    public function test_hints_preference_defaults_to_on_and_can_be_switched_off_in_settings(): void
    {
        $this->actingAs($this->member());
        $this->bootstrap()->assertJsonPath('data.preferences.hints_enabled', true);
        $this->putJson('/api/settings', ['discovery' => ['hints_enabled' => false]])->assertOk();
        $this->bootstrap()->assertJsonPath('data.preferences.hints_enabled', false);
        $this->putJson('/api/settings', ['discovery' => ['hints_enabled' => 'maybe']])->assertUnprocessable();
        $this->putJson('/api/settings', ['discovery' => ['anything_else' => true]])->assertUnprocessable();
    }

    public function test_the_export_includes_the_persons_own_discovery_state_and_nothing_else(): void
    {
        $this->publishable();
        $this->goLive();
        $alice = $this->member();
        $bob = $this->member();
        $this->actingAs($bob)->putJson('/api/discovery/states/release/r-one', ['action' => 'seen']);
        $this->actingAs($alice)->putJson('/api/discovery/states/release/r-one', ['action' => 'dismissed']);
        $export = $this->getJson('/api/export')->assertOk()->json('discovery');
        $this->assertCount(1, $export);
        $this->assertSame('release', $export[0]['type']);
        $this->assertArrayNotHasKey('user_id', $export[0]);
    }
}
