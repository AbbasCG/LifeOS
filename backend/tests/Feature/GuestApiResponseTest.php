<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

/**
 * A signed-out request to the API is answered 401 with JSON whether or not it asks for JSON. Before, one without an Accept header
 * made the framework look for a sign-in page route (`Route [login] not defined`) and answer 500.
 */
class GuestApiResponseTest extends TestCase
{
    use RefreshDatabase;

    /** A value the route's own parameter constraint accepts, so the request reaches the route and its `auth` middleware. */
    private function sampleValue(string $pattern): string
    {
        foreach (['1', 'tasks', 'google', '2026-01-01', '00000000-0000-4000-8000-000000000000', 'abc'] as $candidate) {
            if ($pattern === '' || preg_match('#^(?:'.$pattern.')$#', $candidate)) {
                return $candidate;
            }
        }

        return 'x';
    }

    public function test_a_guest_without_an_accept_header_gets_401_json_not_500(): void
    {
        $response = $this->call('GET', '/api/user');

        $response->assertUnauthorized();
        $response->assertHeader('Content-Type', 'application/json');
        $response->assertJson(['message' => 'Unauthenticated.']);
        $this->assertFalse($response->isRedirect(), 'no redirect to a sign-in page');
    }

    public function test_a_guest_asking_for_json_gets_401_json(): void
    {
        $this->getJson('/api/user')->assertUnauthorized()->assertJson(['message' => 'Unauthenticated.']);
    }

    public function test_every_protected_api_route_answers_401_json_to_a_guest_whatever_the_accept_header(): void
    {
        $checked = 0;
        foreach (Route::getRoutes() as $route) {
            if (! str_starts_with($route->uri(), 'api/') || ! str_contains(implode(' ', $route->gatherMiddleware()), 'auth:sanctum')) {
                continue;
            }
            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                $uri = '/'.preg_replace_callback('/\{([^}?]+)\??\}/', fn (array $m): string => $this->sampleValue((string) ($route->wheres[$m[1]] ?? '')), $route->uri());
                foreach ([[], ['HTTP_ACCEPT' => 'text/html'], ['HTTP_ACCEPT' => '*/*']] as $server) {
                    $response = $this->call($method, $uri, [], [], [], $server);
                    $this->assertSame(401, $response->getStatusCode(), "{$method} {$uri} with ".json_encode($server));
                    $this->assertStringContainsString('application/json', (string) $response->headers->get('Content-Type'), "{$method} {$uri}");
                }
                $checked++;
            }
        }
        $this->assertGreaterThan(100, $checked);
    }

    public function test_the_sign_in_routes_stay_open_and_a_signed_in_user_is_still_recognised(): void
    {
        $this->postJson('/api/login', ['email' => 'nobody@example.com', 'password' => 'x'])->assertUnprocessable();

        $user = User::factory()->create();
        $this->actingAs($user);
        $this->call('GET', '/api/user')->assertOk()->assertJsonPath('id', $user->id);
    }

    public function test_the_app_has_no_login_page_route_and_guests_are_never_redirected(): void
    {
        $this->assertFalse(Route::has('login'), 'the SPA owns /login; there is no server-side sign-in page to redirect to');
        $this->assertFalse($this->call('GET', '/api/user')->isRedirect());
    }
}
