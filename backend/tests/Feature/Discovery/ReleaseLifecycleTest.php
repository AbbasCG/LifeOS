<?php

namespace Tests\Feature\Discovery;

use App\Models\AuditLog;
use App\Models\ProductRelease;
use App\Models\User;
use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\ReleaseService;
use PHPUnit\Framework\Attributes\DataProvider;

/** Registering, approving, withdrawing and rolling back releases: nothing becomes visible without both a healthy deploy and an approval. */
class ReleaseLifecycleTest extends DiscoveryTestCase
{
    private function service(): ReleaseService
    {
        return app(ReleaseService::class);
    }

    public function test_activation_is_off_by_default_so_nothing_is_ever_registered(): void
    {
        $this->publishable();
        config(['discovery.auto_activate' => false]);
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->assertSame(0, ProductRelease::count());
        $this->assertSame([], $this->service()->visibleRows($this->member())->all());
    }

    public function test_switching_activation_off_hides_everything_at_once_even_what_was_approved(): void
    {
        $this->publishable();
        $this->goLive();
        $this->assertTrue(app(ReleaseService::class)->isVisible('r-one', $this->member()));
        config(['discovery.auto_activate' => false]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->assertFalse(app(ReleaseService::class)->isVisible('r-one', $this->member()), 'the switch is a real kill switch, not only a stop for new registrations');
        $this->freshControllers();
        $this->actingAs($this->member())->getJson('/api/discovery/bootstrap')->assertJsonPath('data.announcement', null);
    }

    public function test_the_shipped_defaults_are_automatic_and_both_switches_remain(): void
    {
        // Read from the files, not from the environment, so a developer's or the server's own .env cannot change what this proves.
        $config = (string) file_get_contents(base_path('config/discovery.php'));
        $this->assertStringContainsString("env('DISCOVERY_AUTO_ACTIVATE', true)", $config, 'updates reach people by themselves unless the switch is turned off');
        $this->assertStringContainsString("env('DISCOVERY_AUTO_APPROVE', true)", $config);
        $example = (string) file_get_contents(base_path('.env.example'));
        $this->assertStringContainsString("DISCOVERY_AUTO_ACTIVATE=true\n", $example);
        $this->assertStringContainsString("DISCOVERY_AUTO_APPROVE=true\n", $example);
    }

    #[DataProvider('unconfirmed')]
    public function test_nothing_is_registered_unless_a_healthy_deploy_is_confirmed(string $status): void
    {
        $this->publishable();
        $this->deploy($status);
        $result = $this->service()->reconcile();
        $this->assertSame($status, $result['status']);
        $this->assertSame(0, ProductRelease::count());
    }

    /** @return array<string, array{0: string}> */
    public static function unconfirmed(): array
    {
        return array_combine($s = ['disabled', 'not_confirmed', 'marker_missing', 'marker_unreadable', 'marker_invalid', 'head_unknown'], array_map(fn ($x) => [$x], $s));
    }

    public function test_a_confirmed_deploy_registers_the_release_as_a_draft_that_nobody_sees(): void
    {
        $this->publishable();
        $this->deploy('confirmed', str_repeat('a', 40));
        $result = $this->service()->reconcile();
        $this->assertSame(['r-one'], $result['registered']);
        $row = ProductRelease::where('key', 'r-one')->firstOrFail();
        $this->assertSame('draft', $row->review_status);
        $this->assertSame('live', $row->deploy_status);
        $this->assertSame(str_repeat('a', 40), $row->deployed_sha);
        $this->assertNotNull($row->live_since);
        $this->assertFalse($row->isVisible());
        $this->assertSame([], $this->service()->visibleRows($this->member())->all());
    }

    public function test_reconcile_is_idempotent_and_dry_run_changes_nothing(): void
    {
        $this->publishable();
        $this->deploy();
        $this->service()->reconcile(true);
        $this->assertSame(0, ProductRelease::count());
        $this->service()->reconcile();
        $first = ProductRelease::first()->live_since;
        $this->travel(2)->hours();
        $again = $this->service()->reconcile();
        $this->assertSame([], $again['registered']);
        $this->assertSame(1, ProductRelease::count());
        $this->assertEquals($first, ProductRelease::first()->live_since, 'the time it first went live does not move');
    }

    public function test_text_changed_after_approval_is_hidden_at_once_and_becomes_a_draft_again(): void
    {
        $this->publishable();
        $this->goLive();
        $this->assertTrue(app(ReleaseService::class)->isVisible('r-one', $this->member()));

        // The code now holds other text (even with the same revision number) - for example a deploy that is still in progress.
        $this->publishable(['title' => $this->t('Changed title')]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->assertFalse(app(ReleaseService::class)->isVisible('r-one', $this->member()), 'hidden before anything is confirmed');
        $this->actingAs($this->member())->getJson('/api/discovery/bootstrap')->assertJsonPath('data.announcement', null);

        // Once a healthy deploy confirms the new text it is a draft that needs a new approval.
        $this->deploy();
        $result = app(ReleaseService::class)->reconcile();
        $this->assertSame(['r-one'], $result['needs_review']);
        $row = ProductRelease::first();
        $this->assertSame('draft', $row->review_status);
        $this->assertNotSame($row->approved_hash, $row->content_hash);
        $this->assertFalse(app(ReleaseService::class)->isVisible('r-one', $this->member()));
    }

    public function test_a_feature_text_change_also_needs_a_new_approval(): void
    {
        $this->publishable();
        $this->goLive();
        $this->write('features', $this->feature('quick-capture', ['description' => $this->t('Different description')]));
        $this->app->forgetInstance(ReleaseService::class);
        $this->assertFalse(app(ReleaseService::class)->isVisible('r-one', $this->member()));
    }

    public function test_approval_is_for_the_text_the_administrator_read(): void
    {
        $this->publishable();
        $this->deploy();
        $this->service()->reconcile();
        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        $read = $this->hash();

        $this->postJson('/api/admin/discovery/releases/r-one/approve')->assertUnprocessable();   // the fingerprint is required
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => 'short'])->assertUnprocessable();

        // Someone changes the text between reading and approving: the old fingerprint is refused and nothing is approved.
        $this->publishable(['summary' => $this->t('Sneaked in')]);
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $read])->assertStatus(409)->assertJsonPath('code', 'content_changed');
        $this->assertSame('draft', ProductRelease::first()->review_status);

        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()])->assertOk()->assertJsonPath('data.visible', true);
        $this->assertSame($this->hash(), ProductRelease::first()->approved_hash);
        $this->assertNotNull(ProductRelease::first()->published_at);
    }

    public function test_approving_asks_for_the_password_again_but_taking_down_never_does(): void
    {
        $this->publishable();
        $this->deploy();
        $this->service()->reconcile();
        $this->actingAs($this->admin());
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()])->assertStatus(423);
        $this->assertSame('draft', ProductRelease::first()->review_status);
        $this->postJson('/api/admin/discovery/releases/r-one/withdraw')->assertOk();
    }

    public function test_only_an_administrator_with_two_factor_can_approve_and_only_a_live_release(): void
    {
        $this->publishable();
        $this->deploy();
        $this->service()->reconcile();
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()])->assertUnauthorized();
        $this->actingAs(User::factory()->create());
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()])->assertForbidden()->assertJsonPath('code', 'admin_required');
        $this->getJson('/api/admin/discovery/releases')->assertForbidden();
        $this->actingAs($this->admin(false));
        $this->withSession(['auth.password_confirmed_at' => time()]);
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()])->assertForbidden()->assertJsonPath('code', 'two_factor_required');
        $this->getJson('/api/admin/discovery/releases')->assertOk();
        $this->assertSame('draft', ProductRelease::first()->review_status);
    }

    public function test_approving_publishes_and_is_audited_and_withdrawing_hides_it_at_once(): void
    {
        $this->publishable();
        $this->deploy();
        $this->service()->reconcile();
        $admin = $this->admin();
        $this->actingAs($admin)->withSession(['auth.password_confirmed_at' => time()]);
        $approve = fn () => $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()]);

        $approve()->assertOk()->assertJsonPath('data.visible', true)->assertJsonPath('data.review_status', 'approved');
        $this->assertTrue($this->service()->isVisible('r-one', $this->member()));
        $approve()->assertOk();   // idempotent
        $this->postJson('/api/admin/discovery/releases/r-one/withdraw')->assertOk()->assertJsonPath('data.visible', false)->assertJsonPath('data.review_status', 'withdrawn');
        $this->assertFalse($this->service()->isVisible('r-one', $this->member()));
        $approve()->assertOk()->assertJsonPath('data.visible', true);   // a withdrawn release can be approved again

        $actions = AuditLog::where('user_id', $admin->id)->whereIn('action', ['release_approved', 'release_withdrawn'])->orderBy('id')->pluck('action')->all();
        $this->assertSame(['release_approved', 'release_withdrawn', 'release_approved'], $actions, 'a repeated approval is not logged twice');
        $this->assertSame(['release' => 'r-one', 'revision' => 1], AuditLog::where('action', 'release_approved')->first()->meta);
    }

    public function test_a_release_that_no_healthy_deploy_has_confirmed_cannot_be_approved(): void
    {
        $this->publishable();
        $this->actingAs($this->admin())->withSession(['auth.password_confirmed_at' => time()]);
        $this->postJson('/api/admin/discovery/releases/r-one/approve', ['content_hash' => $this->hash()])->assertStatus(409)->assertJsonPath('code', 'not_deployed');
        $this->postJson('/api/admin/discovery/releases/no-such/approve', ['content_hash' => str_repeat('a', 64)])->assertStatus(409);
        $this->postJson('/api/admin/discovery/releases/Bad_Key/withdraw')->assertNotFound();
        $this->postJson('/api/admin/discovery/releases/no-such/withdraw')->assertNotFound();
        $this->assertSame(0, ProductRelease::count());
    }

    public function test_the_admin_list_shows_what_the_code_contains_and_why_nothing_is_visible(): void
    {
        $this->publishable();
        $this->deploy('marker_unreadable');
        $this->actingAs($this->admin());
        $this->getJson('/api/admin/discovery/releases')->assertOk()
            ->assertJsonPath('data.0.key', 'r-one')->assertJsonPath('data.0.registered', false)->assertJsonPath('data.0.visible', false)
            ->assertJsonPath('activation.status', 'marker_unreadable');
    }

    public function test_a_rollback_hides_a_release_the_older_code_does_not_contain_and_a_roll_forward_restores_it(): void
    {
        $this->publishable();
        $this->goLive();
        $this->assertTrue($this->service()->isVisible('r-one', $this->member()));

        // Roll back: the running code no longer has the release file.
        $this->rollBackFiles();
        $result = app(ReleaseService::class)->reconcile();
        $this->assertSame(['r-one'], $result['absent']);
        $row = ProductRelease::first();
        $this->assertSame('absent', $row->deploy_status);
        $this->assertNotNull($row->absent_since);
        $this->assertSame('approved', $row->review_status, 'the decision is kept; only the deploy state changed');
        $this->assertFalse(app(ReleaseService::class)->isVisible('r-one', $this->member()));

        // Roll forward: the file is back, so it is live again with no new approval and no new row.
        $this->publishable();
        $this->app->forgetInstance(ReleaseService::class);
        app(ReleaseService::class)->reconcile();
        $this->assertSame(1, ProductRelease::count());
        $this->assertSame('live', ProductRelease::first()->deploy_status);
        $this->assertNull(ProductRelease::first()->absent_since);
        $this->assertTrue(app(ReleaseService::class)->isVisible('r-one', $this->member()));
    }

    public function test_a_row_whose_content_file_is_missing_is_never_visible_even_before_reconcile_notices(): void
    {
        $this->publishable();
        $this->goLive();
        $this->rollBackFiles();
        $this->assertSame('live', ProductRelease::first()->deploy_status);
        $this->assertFalse(app(ReleaseService::class)->isVisible('r-one', $this->member()));
    }

    /** Older code has neither the release nor the features that were introduced with it. */
    private function rollBackFiles(): void
    {
        unlink($this->content.'/releases/r-one.json');
        unlink($this->content.'/features/quick-capture.json');
        $this->app->forgetInstance(DiscoveryRegistry::class);
        $this->app->forgetInstance(ReleaseService::class);
    }

    public function test_broken_content_in_the_running_code_changes_nothing_and_does_not_break_the_app(): void
    {
        $this->publishable();
        $this->goLive();
        file_put_contents($this->content.'/releases/r-one.json', '{ not json');
        $this->app->forgetInstance(DiscoveryRegistry::class);
        $this->app->forgetInstance(ReleaseService::class);
        $result = app(ReleaseService::class)->reconcile();
        $this->assertSame('content_invalid', $result['status']);
        $this->assertSame('approved', ProductRelease::first()->review_status);
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/bootstrap')->assertOk()->assertJsonPath('data.announcement', null);
        $this->getJson('/api/discovery/releases')->assertOk()->assertJsonPath('data', []);
        $this->putJson('/api/discovery/states/release/r-one', ['action' => 'seen'])->assertNotFound();
        $this->postJson('/api/discovery/features/quick-capture/try')->assertNotFound();
    }

    public function test_a_failed_or_unfinished_deploy_changes_nothing_that_already_exists(): void
    {
        $this->publishable();
        $this->goLive();
        $before = ProductRelease::first()->only(['review_status', 'deploy_status', 'deployed_sha', 'revision']);
        $this->publishable(['revision' => 5]);
        $this->deploy('not_confirmed', str_repeat('b', 40));
        $this->app->forgetInstance(ReleaseService::class);
        app(ReleaseService::class)->reconcile();
        $this->assertSame($before, ProductRelease::first()->only(['review_status', 'deploy_status', 'deployed_sha', 'revision']));
    }
}
