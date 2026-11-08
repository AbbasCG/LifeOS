<?php

namespace Tests\Feature\Discovery;

use App\Models\User;
use App\Models\UserSetting;
use App\Services\Discovery\FeatureGate;

class FeatureGateTest extends DiscoveryTestCase
{
    private function gate(): FeatureGate
    {
        return app(FeatureGate::class);
    }

    public function test_no_requirements_means_available(): void
    {
        $this->assertSame(['available' => true, 'reason' => null], $this->gate()->check(User::factory()->create(), []));
    }

    public function test_admin_only_features_are_for_administrators(): void
    {
        $this->assertSame('admin_only', $this->gate()->check(User::factory()->create(), ['admin'])['reason']);
        $this->assertTrue($this->gate()->check($this->admin(false), ['admin'])['available']);
    }

    public function test_an_unknown_requirement_is_never_satisfied(): void
    {
        $this->assertSame(['available' => false, 'reason' => 'unknown'], $this->gate()->check($this->admin(), ['teleport']));
        $this->assertFalse(FeatureGate::isValid('integration_ready'), 'a requirement missing its argument is invalid');
        $this->assertFalse(FeatureGate::isValid('admin:extra'));
        $this->assertFalse(FeatureGate::isValid('config:Bad Name'));
    }

    public function test_voice_follows_the_account_setting_and_defaults_to_allowed(): void
    {
        $user = User::factory()->create();
        $this->assertTrue($this->gate()->check($user, ['voice_allowed'])['available']);
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['voice_input' => false]]);
        $this->assertSame('voice_off', $this->gate()->check($user, ['voice_allowed'])['reason']);
    }

    public function test_push_needs_the_installation_to_have_vapid_keys(): void
    {
        $user = User::factory()->create();
        $this->assertSame('push_off', $this->gate()->check($user, ['push_configured'])['reason']);
        config(['services.webpush.public_key' => 'public', 'services.webpush.private_key' => 'private', 'services.webpush.subject' => 'mailto:a@b.co']);
        $this->assertTrue($this->gate()->check($user, ['push_configured'])['available']);
    }

    public function test_an_integration_is_ready_only_with_oauth_credentials(): void
    {
        $user = User::factory()->create();
        $this->assertSame('setup_needed', $this->gate()->check($user, ['integration_ready:google'])['reason']);
        $this->assertSame('setup_needed', $this->gate()->check($user, ['integration_ready:no_such_provider'])['reason']);
        config(['services.google_calendar.client_id' => 'id', 'services.google_calendar.client_secret' => 'secret']);
        $this->assertTrue($this->gate()->check($user, ['integration_ready:google'])['available']);
    }

    public function test_a_named_environment_flag_can_gate_a_feature_but_an_unlisted_one_cannot(): void
    {
        $user = User::factory()->create();
        config(['calendar_write.enabled' => false]);
        $this->assertSame('disabled', $this->gate()->check($user, ['config:calendar_write'])['reason']);
        config(['calendar_write.enabled' => true]);
        $this->assertTrue($this->gate()->check($user, ['config:calendar_write'])['available']);
        config(['app.debug' => true]);
        $this->assertSame('disabled', $this->gate()->check($user, ['config:app_debug'])['reason'], 'only flags listed in config/discovery.php can be read');
    }

    public function test_the_first_unmet_requirement_is_reported(): void
    {
        $this->assertSame('admin_only', $this->gate()->check(User::factory()->create(), ['admin', 'push_configured'])['reason']);
    }
}
