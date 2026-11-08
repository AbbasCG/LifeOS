<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\InboxNotification;
use App\Models\Project;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

/**
 * Guards that hold for the whole API, so a new route cannot quietly skip them:
 * every route needs a signed-in user except the sign-in family, and one account can never read or change another's records.
 */
class RouteSecurityTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The sign-in family, plus the webhook receiver: it has no user session by design and is authenticated by an HMAC signature
     * instead (see WebhookTest, which covers signature, replay, size and disabled-endpoint behaviour).
     */
    private const PUBLIC = ['POST api/forgot-password', 'POST api/login', 'POST api/register', 'POST api/reset-password', 'POST api/two-factor-challenge', 'POST api/webhooks/{publicId}'];

    /**
     * @return array<string, array{string, string}> "METHOD uri" => [method, uri with parameters filled in]
     */
    private function apiRoutes(): array
    {
        $routes = [];
        foreach (Route::getRoutes() as $route) {
            if (! str_starts_with($route->uri(), 'api/')) {
                continue;
            }
            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                $routes[$method.' '.$route->uri()] = [$method, preg_replace_callback('/\{([^}?]+)\??\}/', fn (array $m): string => $this->sampleValue((string) ($route->wheres[$m[1]] ?? '')), $route->uri())];
            }
        }

        return $routes;
    }

    private function sampleValue(string $pattern): string
    {
        foreach (['1', 'tasks', 'google', '2026-01-01', '00000000-0000-4000-8000-000000000000', 'abc'] as $candidate) {
            if ($pattern === '' || preg_match('#^(?:'.$pattern.')$#', $candidate)) {
                return $candidate;
            }
        }

        return 'x';
    }

    public function test_only_the_sign_in_routes_are_open_to_guests(): void
    {
        $routes = $this->apiRoutes();
        $this->assertGreaterThan(100, count($routes), 'The API routes were found');

        $open = [];
        foreach (Route::getRoutes() as $route) {
            if (! str_starts_with($route->uri(), 'api/')) {
                continue;
            }
            $middleware = implode(' ', $route->gatherMiddleware());
            if (! str_contains($middleware, 'auth:sanctum') && ! str_contains($middleware, 'Authenticate:sanctum')) {
                foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                    $open[] = $method.' '.$route->uri();
                }
            }
        }
        sort($open);
        $expected = self::PUBLIC;
        sort($expected);

        $this->assertSame($expected, $open, 'Routes without sign-in: '.implode(', ', $open));
    }

    public function test_guests_get_401_on_every_other_route(): void
    {
        foreach ($this->apiRoutes() as $key => [$method, $uri]) {
            if (in_array($key, self::PUBLIC, true)) {
                continue;
            }
            $this->assertSame(401, $this->json($method, '/'.$uri)->getStatusCode(), $key.' should require sign-in');
        }
    }

    public function test_one_account_cannot_read_change_or_delete_the_records_of_another(): void
    {
        $owner = User::factory()->create();
        $intruder = User::factory()->create();
        $records = [
            'tasks' => Task::factory()->create(['user_id' => $owner->id, 'title' => 'Private task']),
            'projects' => Project::factory()->create(['user_id' => $owner->id]),
            'goals' => Goal::factory()->create(['user_id' => $owner->id]),
            'habits' => Habit::factory()->create(['user_id' => $owner->id]),
            'categories' => Category::factory()->create(['user_id' => $owner->id]),
            'events' => CalendarEvent::factory()->create(['user_id' => $owner->id]),
        ];

        $this->actingAs($intruder);
        foreach ($records as $resource => $record) {
            $this->getJson("/api/{$resource}/{$record->id}")->assertStatus(404);
            $this->patchJson("/api/{$resource}/{$record->id}", ['title' => 'Taken over'])->assertStatus(404);
            $this->deleteJson("/api/{$resource}/{$record->id}")->assertStatus(404);
            $this->assertDatabaseHas($record->getTable(), ['id' => $record->id, 'user_id' => $owner->id]);
        }
        $this->assertSame('Private task', Task::find($records['tasks']->id)->title);

        // Lists never include another account's records.
        foreach (array_keys($records) as $resource) {
            $this->assertSame([], $this->getJson("/api/{$resource}")->assertOk()->json('data'), "{$resource} list is empty for an account with none");
        }
    }

    public function test_notifications_focus_sessions_plans_and_habit_entries_are_the_owners_alone(): void
    {
        $owner = User::factory()->create();
        $intruder = User::factory()->create();
        $notification = InboxNotification::factory()->create(['user_id' => $owner->id]);
        $session = FocusSession::factory()->create(['user_id' => $owner->id]);
        $plan = ScheduleProposal::factory()->create(['user_id' => $owner->id]);
        $habit = Habit::factory()->create(['user_id' => $owner->id]);

        $this->actingAs($intruder);
        $this->patchJson("/api/notifications/{$notification->id}", ['read' => true])->assertStatus(404);
        $this->deleteJson("/api/notifications/{$notification->id}")->assertStatus(404);
        $this->patchJson("/api/focus-sessions/{$session->id}", ['action' => 'cancel'])->assertStatus(404);
        $this->getJson("/api/plans/{$plan->id}")->assertStatus(404);
        $this->postJson("/api/plans/{$plan->id}/accept")->assertStatus(404);
        $this->postJson("/api/plans/{$plan->id}/reject")->assertStatus(404);
        $this->putJson("/api/habits/{$habit->id}/entry", ['date' => now()->toDateString(), 'completed' => true])->assertStatus(404);

        $this->assertDatabaseHas('inbox_notifications', ['id' => $notification->id]);
        $this->assertDatabaseHas('focus_sessions', ['id' => $session->id, 'status' => $session->status]);
        $this->assertDatabaseHas('schedule_proposals', ['id' => $plan->id, 'status' => 'pending']);
        $this->assertDatabaseMissing('habit_entries', ['habit_id' => $habit->id]);
        $this->assertSame(0, $this->getJson('/api/notifications')->assertOk()->json('meta.total') ?? 0);
    }

    public function test_a_record_cannot_be_pointed_at_another_accounts_project_goal_or_category(): void
    {
        $owner = User::factory()->create();
        $intruder = User::factory()->create();
        $project = Project::factory()->create(['user_id' => $owner->id]);
        $goal = Goal::factory()->create(['user_id' => $owner->id]);
        $category = Category::factory()->create(['user_id' => $owner->id]);

        $this->actingAs($intruder);
        $this->postJson('/api/tasks', ['title' => 'Sneaky', 'project_id' => $project->id])->assertUnprocessable();
        $this->postJson('/api/tasks', ['title' => 'Sneaky', 'goal_id' => $goal->id])->assertUnprocessable();
        $this->postJson('/api/tasks', ['title' => 'Sneaky', 'category_id' => $category->id])->assertUnprocessable();
        $this->assertSame(0, Task::where('user_id', $intruder->id)->count());
    }
}
