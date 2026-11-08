<?php

namespace Tests\Feature\Discovery;

use App\Models\ProductRelease;
use App\Services\Discovery\DiscoveryRegistry;

class DiscoveryCommandsTest extends DiscoveryTestCase
{
    public function test_validate_passes_on_the_shipped_content(): void
    {
        $this->app->singleton(DiscoveryRegistry::class, fn () => new DiscoveryRegistry(resource_path('discovery')));
        $this->artisan('lifeos:discovery:validate')->expectsOutputToContain('0 release(s)')->assertSuccessful();
    }

    public function test_validate_reports_a_broken_file_and_a_missing_media_file(): void
    {
        file_put_contents($this->content.'/releases/oops.json', '{}');
        $this->artisan('lifeos:discovery:validate')->assertFailed();
        unlink($this->content.'/releases/oops.json');

        $this->write('features', $this->feature('quick-capture', ['image' => ['src' => '/discovery/r-one/missing.png', 'alt' => $this->t('x')]]));
        $this->write('releases', $this->release('r-one'));
        $this->artisan('lifeos:discovery:validate')->expectsOutputToContain('Missing file: /discovery/r-one/missing.png')->assertFailed();
    }

    public function test_check_marker_is_read_only_and_says_when_it_cannot_verify(): void
    {
        config(['discovery.deploy_marker' => sys_get_temp_dir().'/lifeos-no-such-marker-'.bin2hex(random_bytes(4))]);
        $this->artisan('lifeos:discovery:check-marker')->expectsOutputToContain('marker_missing')->expectsOutputToContain('keep DISCOVERY_AUTO_ACTIVATE off')->assertFailed();
        $this->assertSame(0, ProductRelease::count());
    }

    public function test_reconcile_says_why_it_did_nothing(): void
    {
        $this->artisan('lifeos:discovery:reconcile')->expectsOutputToContain('marker_missing')->assertSuccessful();
    }
}
