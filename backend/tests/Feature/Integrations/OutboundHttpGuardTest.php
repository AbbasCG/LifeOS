<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\HostResolver;
use App\Integrations\Calendar\IcsFeedFetcher;
use App\Integrations\Calendar\ProviderException;
use App\Integrations\Http\GuardedTarget;
use App\Integrations\Http\OutboundBlockedException;
use App\Integrations\Http\OutboundHttpGuard;
use App\Integrations\Http\PublicAddress;
use App\Models\OutboundHostRule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class OutboundHttpGuardTest extends TestCase
{
    use RefreshDatabase;

    /** @var array<string, list<string>> */
    private array $dns = [];

    protected function setUp(): void
    {
        parent::setUp();
        $dns = &$this->dns;
        $this->app->instance(HostResolver::class, new class($dns) extends HostResolver
        {
            public function __construct(private array &$dns) {}

            public function resolve(string $host): array
            {
                return $this->dns[$host] ?? [];
            }
        });
    }

    private function check(string $url): GuardedTarget
    {
        return app(OutboundHttpGuard::class)->check($url);
    }

    private function blocked(string $url, string $needle): void
    {
        try {
            $this->check($url);
            $this->fail("{$url} should be blocked");
        } catch (OutboundBlockedException $e) {
            $this->assertStringContainsString($needle, $e->getMessage(), $url);
        }
    }

    public function test_a_public_https_host_is_allowed_and_pinned_to_the_checked_address(): void
    {
        $this->dns['api.example.com'] = ['93.184.216.34'];
        $target = $this->check('https://api.example.com/v1/items');
        $this->assertSame('93.184.216.34', $target->ip);
        $options = $target->httpOptions();
        $this->assertFalse($options['allow_redirects']);
        $this->assertSame(['api.example.com:443:93.184.216.34'], $options['curl'][CURLOPT_RESOLVE]);
    }

    public function test_the_basics_are_denied_by_default(): void
    {
        $this->dns['api.example.com'] = ['93.184.216.34'];
        $this->blocked('http://api.example.com/', 'https');
        $this->blocked('ftp://api.example.com/', 'https');
        $this->blocked('//api.example.com/', 'https');
        $this->blocked('https://user:pw@api.example.com/', 'username');
        $this->blocked('https://api.example.com:8443/', 'port');
        $this->blocked('https://unknown.example.com/', 'found');
    }

    public function test_private_loopback_and_metadata_addresses_are_blocked(): void
    {
        // Private ranges can be approved by an administrator rule...
        foreach (['10.0.0.5', '172.16.4.4', '192.168.1.20', '100.64.0.1', 'fd00::1', '::ffff:10.0.0.1'] as $ip) {
            $this->dns['erp.example.com'] = [$ip];
            $this->blocked('https://erp.example.com/', 'private');
        }
        // ...this machine itself, link-local and metadata addresses never can.
        foreach (['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1'] as $ip) {
            $this->dns['erp.example.com'] = [$ip];
            $this->blocked('https://erp.example.com/', 'never');
        }
    }

    public function test_one_private_answer_among_public_ones_blocks_the_host(): void
    {
        $this->dns['mixed.example.com'] = ['93.184.216.34', '10.1.1.1'];
        $this->blocked('https://mixed.example.com/', 'private');
    }

    public function test_ip_literals_are_checked_too(): void
    {
        $this->blocked('https://10.0.0.5/', 'private');
        $this->blocked('https://127.0.0.1/', 'never');
        $this->blocked('https://[::1]/', 'never');
        $this->assertSame('93.184.216.34', $this->check('https://93.184.216.34/')->ip);
    }

    public function test_an_administrator_rule_opens_exactly_one_private_host_and_port(): void
    {
        $this->dns['erp.corp.example'] = ['10.20.30.40'];
        $this->dns['other.corp.example'] = ['10.20.30.41'];
        OutboundHostRule::create(['host' => 'erp.corp.example', 'port' => 443, 'allow_private' => true, 'note' => 'EMC']);
        $this->assertSame('10.20.30.40', $this->check('https://erp.corp.example/api')->ip);
        $this->blocked('https://other.corp.example/api', 'private');
        $this->blocked('https://erp.corp.example:8443/api', 'port');
    }

    public function test_a_rule_can_allow_a_custom_port_but_not_a_private_address_unless_asked(): void
    {
        $this->dns['erp.corp.example'] = ['10.20.30.40'];
        OutboundHostRule::create(['host' => 'erp.corp.example', 'port' => 8443, 'allow_private' => false]);
        $this->blocked('https://erp.corp.example:8443/', 'private');
        OutboundHostRule::where('port', 8443)->update(['allow_private' => true]);
        $this->assertSame(8443, $this->check('https://erp.corp.example:8443/')->port);
    }

    public function test_loopback_and_metadata_stay_blocked_even_with_a_rule(): void
    {
        foreach (['127.0.0.1', '169.254.169.254', '::1'] as $ip) {
            $this->dns['sneaky.corp.example'] = [$ip];
            OutboundHostRule::updateOrCreate(['host' => 'sneaky.corp.example', 'port' => 443], ['allow_private' => true]);
            $this->blocked('https://sneaky.corp.example/', 'never');
        }
    }

    public function test_the_shared_classifier_keeps_the_calendar_feed_behaviour(): void
    {
        $this->assertTrue(PublicAddress::isPublic('8.8.8.8'));
        $this->assertTrue(PublicAddress::isPublic('2606:4700:4700::1111'));
        foreach (['10.0.0.1', '100.64.1.1', '::ffff:192.168.0.1', 'fe80::1', 'fc00::1', '::'] as $ip) {
            $this->assertFalse(PublicAddress::isPublic($ip), $ip);
        }
        $this->assertFalse(PublicAddress::isNeverAllowed('10.0.0.1'), 'RFC1918 can be approved by a rule');
        $this->assertTrue(PublicAddress::isNeverAllowed('not-an-ip'));
    }

    public function test_ipv6_forms_that_embed_a_private_ipv4_address_are_refused(): void
    {
        $refused = ['64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '2002:a9fe:a9fe::', '2002:7f00:1::', '::127.0.0.1', 'fec0::1',
            '64:ff9b::a00:1', '2002:c0a8:1::', '100::1', '2001:db8::1', '::ffff:169.254.169.254',
            // Teredo: server 8.8.8.8 with client 127.0.0.1 (stored inverted), then the reverse
            '2001:0:808:808::80ff:fffe', '2001:0:7f00:1::f7f7:f7f7',
            '64:ff9b:1::1', '::ffff:0:7f00:1', '2001:2::1', '2001:10::1', '3fff::1'];
        foreach ($refused as $ip) {
            $this->assertFalse(PublicAddress::isPublic($ip), $ip);
        }
        foreach (['64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '2002:a9fe:a9fe::', '2002:7f00:1::', '::127.0.0.1', '::ffff:0:7f00:1', '2001:0:808:808::80ff:fffe'] as $ip) {
            $this->assertTrue(PublicAddress::isNeverAllowed($ip), $ip);
        }
        foreach (['8.8.8.8', '2606:4700:4700::1111', '64:ff9b::808:808', '2002:808:808::', '2001:0:808:808::f7f7:f7f7'] as $ip) {
            $this->assertTrue(PublicAddress::isPublic($ip), $ip);
            $this->assertFalse(PublicAddress::isNeverAllowed($ip), $ip);
        }
    }

    public function test_the_guard_and_feed_fetcher_refuse_embedded_ipv4_addresses(): void
    {
        foreach (['64:ff9b::a9fe:a9fe', '2002:7f00:1::', '::127.0.0.1'] as $ip) {
            $this->dns['erp.example.com'] = [$ip];
            $this->blocked('https://erp.example.com/', 'never');
        }
        $this->dns['feed.example.com'] = ['64:ff9b::a9fe:a9fe'];
        $this->expectException(ProviderException::class);
        app(IcsFeedFetcher::class)->fetch('https://feed.example.com/cal.ics');
    }
}
