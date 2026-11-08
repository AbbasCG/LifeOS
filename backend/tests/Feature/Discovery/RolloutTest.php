<?php

namespace Tests\Feature\Discovery;

use App\Models\AuditLog;
use App\Models\DiscoveryTester;
use App\Models\InboxNotification;
use App\Models\ProductRelease;
use App\Models\User;
use App\Services\Discovery\ReleaseService;

/**
 * Staged rollout: who may see an approved, live release is decided by the server, for every answer about a person and for the notification, and the
 * default (everyone) leaves every release that is live today exactly as it was.
 */
class RolloutTest extends DiscoveryTestCase
{
    private function prepare(string $stage = 'general'): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->publishable([], ['tour' => 'quick-tour']);
        $this->goLive();
        ProductRelease::where('key', 'r-one')->update(['rollout' => $stage]);
        $this->forget();
    }

    private function forget(): void
    {
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
    }

    /** An administrator who joined long before the release, so the announcement is theirs to see. */
    private function oldAdmin(): User
    {
        $admin = $this->admin();
        $admin->forceFill(['created_at' => now()->subDays(40)])->save();

        return $admin;
    }

    /** @return array<string, mixed> everything one person can learn about the release, as the endpoints answer it */
    private function seenBy(User $user): array
    {
        $this->actingAs($user);
        $boot = $this->getJson('/api/discovery/bootstrap')->assertOk()->json('data');

        return [
            'announcement' => $boot['announcement']['key'] ?? null,
            'unseen' => $boot['counts']['unseen_updates'],
            'history' => count($this->getJson('/api/discovery/releases')->json('data')),
            'features' => count($this->getJson('/api/discovery/features')->json('data')),
            'new' => count($this->getJson('/api/discovery/guide')->json('data.new')),
            'tour' => $this->getJson('/api/discovery/tours/quick-tour')->status(),
            'state' => $this->putJson('/api/discovery/states/release/r-one', ['action' => 'seen'])->status(),
            'try' => $this->postJson('/api/discovery/features/quick-capture/try')->status(),
        ];
    }

    private const NOTHING = ['announcement' => null, 'unseen' => 0, 'history' => 0, 'features' => 0, 'new' => 0, 'tour' => 404, 'state' => 404, 'try' => 404];

    public function test_by_default_everybody_sees_a_release_as_before(): void
    {
        $member = $this->member();
        $this->prepare();
        $this->assertSame('general', ProductRelease::firstOrFail()->rollout);
        $seen = $this->seenBy($member);
        $this->assertSame('r-one', $seen['announcement']);
        $this->assertSame(200, $seen['tour']);
        $this->assertSame(200, $seen['try']);
        $this->assertSame(1, $seen['features']);
    }

    public function test_the_shipped_default_is_everyone_so_nothing_that_is_live_changes(): void
    {
        $this->assertStringContainsString("'default_rollout' => env('DISCOVERY_DEFAULT_ROLLOUT', 'general')", (string) file_get_contents(config_path('discovery.php')));
        $this->assertStringContainsString("\nDISCOVERY_DEFAULT_ROLLOUT=general\n", (string) file_get_contents(base_path('.env.example')));
    }

    public function test_a_new_release_takes_the_configured_default_stage_and_a_bad_value_means_everyone(): void
    {
        config(['discovery.default_rollout' => 'admin']);
        $this->publishable();
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->assertSame('admin', ProductRelease::firstOrFail()->rollout);
        ProductRelease::query()->delete();
        config(['discovery.default_rollout' => 'everyone-please']);
        $this->app->forgetInstance(ReleaseService::class);
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->assertSame('general', ProductRelease::firstOrFail()->rollout, 'an unknown value never narrows or widens by accident');
    }

    public function test_in_the_admin_stage_only_administrators_see_it_in_every_answer(): void
    {
        $member = $this->member();
        $admin = $this->oldAdmin();
        $this->prepare('admin');
        $this->assertSame(self::NOTHING, $this->seenBy($member));
        $seen = $this->seenBy($admin);
        $this->assertSame('r-one', $seen['announcement']);
        $this->assertSame([1, 1, 1, 1, 200, 200, 200], [$seen['unseen'], $seen['history'], $seen['features'], $seen['new'], $seen['tour'], $seen['state'], $seen['try']]);
    }

    public function test_in_the_internal_stage_administrators_and_test_accounts_see_it_but_nobody_else(): void
    {
        $tester = $this->member();
        $member = $this->member();
        $admin = $this->oldAdmin();
        DiscoveryTester::create(['user_id' => $tester->id]);
        $this->prepare('internal');
        $this->assertSame(self::NOTHING, $this->seenBy($member));
        $this->assertSame('r-one', $this->seenBy($tester)['announcement']);
        $this->assertSame('r-one', $this->seenBy($admin)['announcement']);
    }

    public function test_the_notification_goes_only_to_people_the_stage_includes(): void
    {
        $member = $this->member();
        $admin = $this->oldAdmin();
        $this->prepare('admin');
        // Only opening the app (the bootstrap), as people do; reading the announcement would clear its notification again.
        $open = function (User $user): void {
            $this->actingAs($user);
            $this->getJson('/api/discovery/bootstrap')->assertOk();
        };
        $open($member);
        $this->assertSame(0, InboxNotification::where('user_id', $member->id)->count(), 'a test release sends nobody outside its stage a notification');
        $open($admin);
        $this->assertSame(1, InboxNotification::where('user_id', $admin->id)->count());
        // Widened to everyone: now the member is told, once.
        ProductRelease::where('key', 'r-one')->update(['rollout' => 'general']);
        $this->forget();
        $open($member);
        $open($member);
        $this->assertSame(1, InboxNotification::where('user_id', $member->id)->count());
    }

    public function test_changing_the_stage_takes_effect_at_once_in_both_directions(): void
    {
        $member = $this->member();
        $this->prepare('general');
        $this->assertSame('r-one', $this->seenBy($member)['announcement']);
        ProductRelease::where('key', 'r-one')->update(['rollout' => 'admin']);
        $this->forget();
        $this->assertSame(self::NOTHING, $this->seenBy($member));
    }

    public function test_an_unknown_stage_in_the_table_reaches_nobody(): void
    {
        $admin = $this->oldAdmin();
        $this->prepare('typo');
        $this->assertSame(self::NOTHING, $this->seenBy($admin));
    }

    // ---- the administrator screen's endpoints ----

    public function test_changing_the_stage_is_for_administrators_with_two_factor_and_is_logged_once(): void
    {
        $admin = $this->oldAdmin();
        $this->prepare('general');
        $this->actingAs($this->member());
        $this->putJson('/api/admin/discovery/releases/r-one/rollout', ['stage' => 'admin'])->assertForbidden()->assertJsonPath('code', 'admin_required');
        $this->actingAs($this->admin(false));
        $this->putJson('/api/admin/discovery/releases/r-one/rollout', ['stage' => 'admin'])->assertForbidden()->assertJsonPath('code', 'two_factor_required');
        $this->assertSame('general', ProductRelease::firstOrFail()->rollout);

        $this->actingAs($admin);
        $this->putJson('/api/admin/discovery/releases/r-one/rollout', ['stage' => 'internal'])->assertOk()->assertJsonPath('data.rollout', 'internal');
        $this->putJson('/api/admin/discovery/releases/r-one/rollout', ['stage' => 'internal'])->assertOk();
        $entries = AuditLog::where('action', 'release_rollout_changed')->get();
        $this->assertCount(1, $entries, 'a repeat that changed nothing is not logged');
        $this->assertSame(['release' => 'r-one', 'from' => 'general', 'to' => 'internal'], $entries[0]->meta);
    }

    public function test_a_stage_must_be_known_and_the_release_must_exist(): void
    {
        $this->prepare();
        $this->actingAs($this->oldAdmin());
        $this->putJson('/api/admin/discovery/releases/r-one/rollout', ['stage' => 'everyone'])->assertUnprocessable();
        $this->putJson('/api/admin/discovery/releases/r-one/rollout', [])->assertUnprocessable();
        $this->putJson('/api/admin/discovery/releases/nope-nope/rollout', ['stage' => 'admin'])->assertNotFound()->assertJsonPath('code', 'release_unknown');
        $this->putJson('/api/admin/discovery/releases/BAD_KEY/rollout', ['stage' => 'admin'])->assertNotFound();
    }

    public function test_test_accounts_are_managed_by_administrators_only(): void
    {
        $person = $this->member(['email' => 'tester@example.test', 'name' => 'Tess']);
        $this->actingAs($this->member());
        $this->getJson('/api/admin/discovery/testers')->assertForbidden();
        $this->postJson('/api/admin/discovery/testers', ['email' => 'tester@example.test'])->assertForbidden();
        $this->deleteJson('/api/admin/discovery/testers/'.$person->id)->assertForbidden();

        $this->actingAs($this->oldAdmin());
        $this->postJson('/api/admin/discovery/testers', ['email' => 'tester@example.test'])->assertCreated()->assertJsonPath('data.id', $person->id);
        $this->postJson('/api/admin/discovery/testers', ['email' => 'tester@example.test'])->assertOk();
        $this->postJson('/api/admin/discovery/testers', ['email' => 'nobody@example.test'])->assertNotFound()->assertJsonPath('code', 'user_unknown');
        $this->postJson('/api/admin/discovery/testers', ['email' => 'not-an-address'])->assertUnprocessable();
        $this->getJson('/api/admin/discovery/testers')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.email', 'tester@example.test');
        $this->assertSame(1, AuditLog::where('action', 'discovery_tester_added')->count(), 'adding the same account twice is logged once');

        $this->deleteJson('/api/admin/discovery/testers/'.$person->id)->assertOk();
        $this->deleteJson('/api/admin/discovery/testers/'.$person->id)->assertOk();
        $this->assertSame(0, DiscoveryTester::count());
        $this->assertSame(1, AuditLog::where('action', 'discovery_tester_removed')->count());
    }

    public function test_deleting_an_account_removes_it_from_the_test_accounts(): void
    {
        $person = $this->member();
        DiscoveryTester::create(['user_id' => $person->id]);
        $person->delete();
        $this->assertSame(0, DiscoveryTester::count());
    }

    public function test_the_list_shows_the_stage_and_why_a_release_is_not_shown(): void
    {
        $this->publishable();
        $this->actingAs($this->oldAdmin());
        $row = $this->getJson('/api/admin/discovery/releases')->assertOk()->json('data.0');
        $this->assertSame(['not_registered'], $row['blockers']);
        $this->assertSame('general', $row['rollout']);

        $this->goLive();
        $this->assertSame([], $this->getJson('/api/admin/discovery/releases')->json('data.0.blockers'), 'a release that is shown has nothing blocking it');

        $this->write('releases', $this->release('r-one', ['revision' => 2, 'summary' => $this->t('Edited')]));
        $this->assertSame(['content_changed'], $this->getJson('/api/admin/discovery/releases')->json('data.0.blockers'));
        $this->reapprove();

        ProductRelease::where('key', 'r-one')->update(['review_status' => 'withdrawn']);
        $this->forget();
        $this->assertSame(['withdrawn'], $this->getJson('/api/admin/discovery/releases')->json('data.0.blockers'));
        ProductRelease::where('key', 'r-one')->update(['review_status' => 'draft', 'deploy_status' => 'absent']);
        $this->forget();
        $this->assertSame(['not_live', 'not_approved'], $this->getJson('/api/admin/discovery/releases')->json('data.0.blockers'));

        config(['discovery.auto_activate' => false]);
        $this->forget();
        $this->assertContains('activation_off', $this->getJson('/api/admin/discovery/releases')->json('data.0.blockers'));
    }

    public function test_the_numbers_count_who_could_see_it_and_name_nobody(): void
    {
        $tester = $this->member(['email' => 'secret-tester@example.test']);
        $this->member();
        $this->member();
        $this->oldAdmin();
        DiscoveryTester::create(['user_id' => $tester->id]);
        $this->prepare('general');
        $late = User::factory()->create(['created_at' => now()->addDay()]);
        $this->actingAs($this->oldAdmin());

        $get = function (string $stage): array {
            ProductRelease::where('key', 'r-one')->update(['rollout' => $stage]);
            $this->forget();

            return $this->getJson('/api/admin/discovery/stats')->assertOk()->json('data.releases.0');
        };
        $this->assertSame(['general', 5], [$get('general')['rollout'], $get('general')['eligible']], '3 members + 2 administrators, not the one who joined later');
        $this->assertSame(3, $get('internal')['eligible'], '2 administrators + 1 test account');
        $this->assertSame(2, $get('admin')['eligible']);
        $json = json_encode($get('general'));
        $this->assertStringNotContainsString('secret-tester', (string) $json);
        $this->assertStringNotContainsString((string) $late->email, (string) $json);
    }
}
