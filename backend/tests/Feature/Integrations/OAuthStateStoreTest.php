<?php

namespace Tests\Feature\Integrations;

use App\Integrations\OAuth\OAuthStateStore;
use App\Models\OauthState;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class OAuthStateStoreTest extends TestCase
{
    use RefreshDatabase;

    private OAuthStateStore $store;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new OAuthStateStore;
    }

    public function test_pkce_challenge_is_the_s256_of_the_verifier(): void
    {
        $user = User::factory()->create();
        $begin = $this->store->begin($user, 'google');
        $this->assertSame(rtrim(strtr(base64_encode(hash('sha256', $begin['verifier'], true)), '+/', '-_'), '='), $begin['challenge']);
        $this->assertGreaterThanOrEqual(43, strlen($begin['verifier']));
        $this->assertLessThanOrEqual(128, strlen($begin['verifier']));
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9_\-]+$/', $begin['verifier']);
        // RFC 7636 appendix B test vector.
        $this->assertSame('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', OAuthStateStore::challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'));
    }

    public function test_a_state_works_exactly_once_for_the_right_user_and_provider(): void
    {
        $user = User::factory()->create();
        $begin = $this->store->begin($user, 'google', '/settings/integrations');
        $this->assertNull($this->store->consume($begin['state'], User::factory()->create(), 'google'), 'another user cannot use it');
        $this->assertNull($this->store->consume($begin['state'], $user, 'outlook'), 'another provider cannot use it');
        $this->assertNull($this->store->consume('wrong'.$begin['state'], $user, 'google'));
        $this->assertNull($this->store->consume('', $user, 'google'));

        $ok = $this->store->consume($begin['state'], $user, 'google');
        $this->assertSame($begin['verifier'], $ok['verifier']);
        $this->assertSame('/settings/integrations', $ok['return_to']);
        $this->assertNull($this->store->consume($begin['state'], $user, 'google'), 'a state is single use (replay)');
    }

    public function test_an_expired_state_is_refused(): void
    {
        $user = User::factory()->create();
        $begin = $this->store->begin($user, 'google');
        $this->travel(601)->seconds();
        $this->assertNull($this->store->consume($begin['state'], $user, 'google'));
    }

    public function test_state_and_verifier_are_not_readable_from_the_database(): void
    {
        $user = User::factory()->create();
        $begin = $this->store->begin($user, 'google');
        $raw = (array) DB::table('oauth_states')->first();
        $this->assertStringNotContainsString($begin['state'], json_encode($raw));
        $this->assertStringNotContainsString($begin['verifier'], json_encode($raw));
        $this->assertSame(hash('sha256', $begin['state']), $raw['state_hash']);
        $this->assertArrayNotHasKey('verifier', OauthState::first()->toArray());
    }

    public function test_two_concurrent_callbacks_cannot_both_win(): void
    {
        $user = User::factory()->create();
        $begin = $this->store->begin($user, 'google');
        $results = [$this->store->consume($begin['state'], $user, 'google'), $this->store->consume($begin['state'], $user, 'google')];
        $this->assertCount(1, array_filter($results));
    }

    public function test_return_to_only_keeps_same_site_paths(): void
    {
        foreach (['https://evil.example/x', '//evil.example', '/\\evil', "/ok\n", 'javascript:alert(1)', '', null, '/'.str_repeat('a', 300)] as $bad) {
            $this->assertNull(OAuthStateStore::safeReturnTo($bad), (string) $bad);
        }
        $this->assertSame('/settings/integrations?x=1', OAuthStateStore::safeReturnTo('/settings/integrations?x=1'));
    }

    public function test_prune_removes_expired_and_used_states_only(): void
    {
        $user = User::factory()->create();
        $live = $this->store->begin($user, 'google');
        $this->store->begin($user, 'outlook');
        $this->travel(2)->hours();
        $fresh = $this->store->begin($user, 'todoist');
        $this->assertSame(2, $this->store->prune());
        $this->assertNotNull($this->store->consume($fresh['state'], $user, 'todoist'));
        $this->assertNull($this->store->consume($live['state'], $user, 'google'));
    }
}
