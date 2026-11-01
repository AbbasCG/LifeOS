<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SecurityHeadersTest extends TestCase
{
    use RefreshDatabase;

    public function test_responses_carry_baseline_protection_headers(): void
    {
        $response = $this->get('/up');

        $response->assertHeader('X-Content-Type-Options', 'nosniff');
        $response->assertHeader('Referrer-Policy', 'no-referrer');
        $response->assertHeader('X-Frame-Options', 'DENY');
        $this->assertStringContainsString('microphone=(self)', $response->headers->get('Permissions-Policy'));
        $this->assertStringContainsString('geolocation=()', $response->headers->get('Permissions-Policy'));
    }

    public function test_api_responses_are_never_cached(): void
    {
        $this->actingAs(User::factory()->create());

        $cache = (string) $this->getJson('/api/tasks')->assertOk()->headers->get('Cache-Control');

        $this->assertStringContainsString('no-store', $cache);
        $this->assertStringContainsString('private', $cache);
    }

    public function test_a_foreign_origin_is_not_allowed_by_cors(): void
    {
        $response = $this->call('OPTIONS', '/api/tasks', [], [], [], [
            'HTTP_ORIGIN' => 'https://evil.example',
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'GET',
        ]);

        $this->assertNull($response->headers->get('Access-Control-Allow-Origin'));

        $actual = $this->getJson('/api/tasks', ['Origin' => 'https://evil.example']);
        $this->assertNull($actual->headers->get('Access-Control-Allow-Origin'));
    }
}
