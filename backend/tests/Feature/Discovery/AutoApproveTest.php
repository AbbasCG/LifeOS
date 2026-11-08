<?php

namespace Tests\Feature\Discovery;

use App\Models\ProductRelease;
use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\ReleaseService;

/** Updates reach people by themselves after a healthy deploy: registered, approved on the fingerprint of the deployed text, and shown. */
class AutoApproveTest extends DiscoveryTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        config(['discovery.auto_approve' => true]);
    }

    private function reconcile(): void
    {
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
    }

    public function test_a_healthy_deploy_publishes_the_release_without_anybody_clicking(): void
    {
        $this->publishable();
        $this->deploy();
        $person = $this->member();
        $this->reconcile();
        $row = ProductRelease::where('key', 'r-one')->firstOrFail();
        $this->assertSame('approved', $row->review_status);
        $this->assertSame($this->hash(), $row->approved_hash);
        $this->assertNull($row->reviewed_by, 'nobody is named as the reviewer');
        $this->assertNotNull($row->published_at);
        $this->actingAs($person);
        $this->getJson('/api/discovery/bootstrap')->assertOk()->assertJsonPath('data.announcement.key', 'r-one');
        $this->getJson('/api/discovery/releases')->assertOk()->assertJsonCount(1, 'data');
    }

    public function test_the_reconcile_report_and_a_dry_run(): void
    {
        $this->publishable();
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile', ['--dry-run' => true])->expectsOutputToContain('approved: r-one')->assertSuccessful();
        $this->assertSame(0, ProductRelease::count(), 'a dry run writes nothing');
        $this->artisan('lifeos:discovery:reconcile')->expectsOutputToContain('approved: r-one')->assertSuccessful();
    }

    public function test_it_can_be_switched_back_to_approval_by_hand(): void
    {
        config(['discovery.auto_approve' => false]);
        $this->publishable();
        $this->deploy();
        $this->reconcile();
        $this->assertSame('draft', ProductRelease::firstOrFail()->review_status);
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/bootstrap')->assertOk()->assertJsonPath('data.announcement', null);
    }

    public function test_nothing_happens_unless_the_deploy_is_confirmed_or_the_switch_is_on(): void
    {
        $this->publishable();
        $this->deploy('not_confirmed');
        $this->reconcile();
        $this->assertSame(0, ProductRelease::count());
        $this->deploy('marker_unreadable');
        $this->reconcile();
        $this->assertSame(0, ProductRelease::count(), 'a marker that cannot be read fails closed');
        config(['discovery.auto_activate' => false]);
        $this->deploy('disabled');
        $this->reconcile();
        $this->assertSame(0, ProductRelease::count(), 'the kill switch stops it');
    }

    public function test_edited_text_is_approved_again_once_the_edit_is_deployed_and_never_before(): void
    {
        $this->publishable();
        $this->deploy();
        $this->reconcile();
        $first = $this->hash();
        // The text in the code changes (a merged edit) but has not been through a deploy and reconcile yet: the old approval no longer covers it, so it is not shown.
        $this->publishable(['summary' => $this->t('Reworded summary')]);
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/bootstrap')->assertOk()->assertJsonPath('data.announcement', null);
        $this->reconcile();
        $row = ProductRelease::firstOrFail();
        $this->assertNotSame($first, $this->hash());
        $this->assertSame($this->hash(), $row->approved_hash);
        $this->getJson('/api/discovery/bootstrap')->assertOk()->assertJsonPath('data.announcement.summary', 'en Reworded summary');
    }

    public function test_a_release_an_administrator_withdrew_is_never_approved_again_by_this(): void
    {
        $this->publishable();
        $this->deploy();
        $this->reconcile();
        $this->actingAs($this->admin());
        $this->postJson('/api/admin/discovery/releases/r-one/withdraw')->assertOk();
        $this->publishable(['summary' => $this->t('Edited after the withdrawal')]);
        $this->reconcile();
        $this->assertSame('withdrawn', ProductRelease::firstOrFail()->review_status);
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/bootstrap')->assertOk()->assertJsonPath('data.announcement', null);
    }

    public function test_a_release_that_left_the_code_is_marked_absent_and_hidden(): void
    {
        $this->publishable();
        $this->deploy();
        $this->reconcile();
        // A rollback removes the whole commit: the release and the feature that arrived with it.
        @unlink("{$this->content}/releases/r-one.json");
        @unlink("{$this->content}/features/quick-capture.json");
        $this->app->forgetInstance(DiscoveryRegistry::class);
        $this->reconcile();
        $this->assertSame('absent', ProductRelease::firstOrFail()->deploy_status);
    }

    public function test_the_administrator_screen_says_it_was_approved_automatically(): void
    {
        $this->publishable();
        $this->deploy();
        $this->reconcile();
        $this->actingAs($this->admin());
        $answer = $this->getJson('/api/admin/discovery/releases')->assertOk();
        $answer->assertJsonPath('data.0.auto_approved', true)->assertJsonPath('data.0.visible', true)->assertJsonPath('activation.auto_approve', true);
        $this->postJson('/api/admin/discovery/releases/r-one/withdraw')->assertOk();
        $this->getJson('/api/admin/discovery/releases')->assertJsonPath('data.0.review_status', 'withdrawn');
    }
}
