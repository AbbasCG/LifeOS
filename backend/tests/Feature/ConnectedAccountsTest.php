<?php

namespace Tests\Feature;

use App\Models\CalendarAccount;
use App\Models\CalendarEvent;
use App\Models\ExternalEvent;
use App\Models\ExternalTask;
use App\Models\Task;
use App\Models\User;
use App\Models\UserSetting;
use App\Services\CalendarService;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ConnectedAccountsTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        // Monday 4 January 2027, 08:00 Amsterdam.
        $this->travelTo(CarbonImmutable::parse('2027-01-04 07:00:00', 'UTC'));
        config([
            'app.frontend_url' => 'https://app.lifeos.test',
            'ai.provider' => 'disabled',
            'services.google_calendar' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google/callback'],
            'services.google_tasks' => ['client_id' => 'gid', 'client_secret' => 'gsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/google_tasks/callback'],
            'services.microsoft_calendar' => ['client_id' => 'mid', 'client_secret' => 'msecret', 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/outlook/callback'],
            'services.microsoft_todo' => ['client_id' => null, 'client_secret' => null, 'tenant' => 'common', 'redirect' => 'https://app.lifeos.test/api/integrations/microsoft_todo/callback'],
            'services.todoist' => ['client_id' => 'tid', 'client_secret' => 'tsecret', 'redirect' => 'https://app.lifeos.test/api/integrations/todoist/callback'],
        ]);
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam', 'work_start' => '09:00', 'work_end' => '17:00', 'work_days' => [1, 2, 3, 4, 5]]]);
        $this->actingAs($this->user);
    }

    private function connect(string $provider): CalendarAccount
    {
        $url = $this->postJson("/api/integrations/{$provider}/connect")->assertOk()->json('authorization_url');
        parse_str(parse_url($url, PHP_URL_QUERY), $query);
        $this->get("/api/integrations/{$provider}/callback?code=auth-code&state=".$query['state'])->assertRedirect("https://app.lifeos.test/settings/integrations?connected={$provider}");

        return CalendarAccount::where('provider', $provider)->latest('id')->firstOrFail();
    }

    private function fakeGoogle(): void
    {
        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'g-access', 'refresh_token' => 'g-refresh', 'expires_in' => 3600]),
            'openidconnect.googleapis.com/*' => Http::response(['sub' => 'g-1', 'email' => 'me@gmail.com', 'name' => 'Me']),
            'www.googleapis.com/calendar/v3/users/me/calendarList*' => Http::response(['items' => [
                ['id' => 'me@gmail.com', 'summary' => 'Me', 'primary' => true, 'timeZone' => 'Europe/Amsterdam'],
                ['id' => 'work-cal', 'summary' => 'Work', 'timeZone' => 'Europe/Amsterdam'],
            ]]),
            'www.googleapis.com/calendar/v3/calendars/me%40gmail.com/*' => Http::response(['items' => [['id' => 'p1', 'summary' => 'Dentist', 'start' => ['dateTime' => '2027-01-04T15:00:00+01:00'], 'end' => ['dateTime' => '2027-01-04T16:00:00+01:00']]]]),
            'www.googleapis.com/calendar/v3/calendars/work-cal/*' => Http::response(['items' => [['id' => 'w1', 'summary' => 'Team sync', 'start' => ['dateTime' => '2027-01-04T10:00:00+01:00'], 'end' => ['dateTime' => '2027-01-04T10:30:00+01:00']]]]),
            'tasks.googleapis.com/tasks/v1/users/@me/lists*' => Http::response(['items' => [['id' => 'L1', 'title' => 'My Tasks'], ['id' => 'L2', 'title' => 'Groceries']]]),
            'tasks.googleapis.com/tasks/v1/lists/L1/tasks*' => Http::response(['items' => [
                ['id' => 't1', 'title' => 'Renew passport', 'due' => '2027-01-05T00:00:00.000Z', 'status' => 'needsAction', 'webViewLink' => 'https://tasks.google.com/task/t1'],
                ['id' => 't2', 'title' => 'Done already', 'status' => 'completed'],
                ['id' => 't3', 'title' => '', 'status' => 'needsAction'],
            ]]),
            'tasks.googleapis.com/tasks/v1/lists/L2/tasks*' => Http::response(['items' => [['id' => 'g1', 'title' => 'Milk', 'status' => 'needsAction']]]),
            'oauth2.googleapis.com/revoke' => Http::response([]),
        ]);
    }

    public function test_hub_groups_providers_with_honest_states_and_never_exposes_secrets(): void
    {
        $response = $this->getJson('/api/integrations')->assertOk()->assertJsonPath('ai_connected_data', false);
        $categories = collect($response->json('categories'))->keyBy('key');
        $this->assertSame(['calendars', 'tasks', 'productivity', 'email', 'future'], $categories->keys()->all());
        $status = collect($response->json('categories'))->flatMap(fn ($c) => $c['providers'])->pluck('status', 'provider');
        $this->assertSame('available', $status['google']);
        $this->assertSame('available', $status['todoist']);
        $this->assertSame('needs_configuration', $status['microsoft_todo']);
        foreach (['notion', 'gmail', 'outlook_mail', 'apple_calendar'] as $planned) {
            $this->assertSame('planned', $status[$planned]);
        }
        $this->assertStringNotContainsString('gsecret', $response->getContent());
        $this->postJson('/api/integrations/notion/connect')->assertNotFound();
        $this->postJson('/api/integrations/microsoft_todo/connect')->assertUnprocessable();
    }

    public function test_new_connections_import_only_the_primary_calendar_until_the_user_chooses_more(): void
    {
        $this->fakeGoogle();
        $account = $this->connect('google');
        $this->assertSame(['Dentist'], ExternalEvent::pluck('title')->all());
        $this->assertSame([true, false], array_column($account->fresh()->collections, 'included'));
        Http::assertNotSent(fn (HttpRequest $r) => str_contains($r->url(), 'calendars/work-cal'));

        $this->patchJson("/api/integrations/accounts/{$account->id}", ['included' => ['work-cal']])->assertOk()->assertJsonPath('account.collections.1.included', true);
        $this->assertSame(['Team sync'], ExternalEvent::pluck('title')->all(), 'the excluded calendar’s events are removed');
        $this->assertDatabaseHas('audit_logs', ['action' => 'integration_collections_changed']);

        $this->patchJson("/api/integrations/accounts/{$account->id}", ['included' => ['someone-elses-cal']])->assertUnprocessable();
        $this->actingAs(User::factory()->create())->patchJson("/api/integrations/accounts/{$account->id}", ['included' => []])->assertNotFound();
    }

    public function test_accounts_from_before_selection_keep_their_calendars(): void
    {
        $this->fakeGoogle();
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g-1', 'access_token' => 'g-access', 'refresh_token' => 'g-refresh', 'token_expires_at' => now()->addHour(), 'status' => 'active']);
        $this->assertNull($account->collections);

        app(CalendarSyncService::class)->sync($account);
        $this->assertEqualsCanonicalizing(['Dentist', 'Team sync'], ExternalEvent::pluck('title')->all());
        $this->assertSame([true, true], array_column($account->fresh()->collections, 'included'));
    }

    public function test_the_same_commitment_from_several_sources_appears_once(): void
    {
        $google = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'access_token' => 'x', 'status' => 'active']);
        $outlook = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'outlook', 'external_account_id' => 'o', 'access_token' => 'x', 'status' => 'active']);
        $at = fn (string $t) => CarbonImmutable::parse("2027-01-05 {$t}", 'Europe/Amsterdam')->utc();
        foreach ([$google, $outlook] as $i => $account) {
            ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'external_id' => "e{$i}", 'title' => $i ? 'Quarterly  review' : 'quarterly review', 'starts_at' => $at('10:00'), 'ends_at' => $at('11:00')]);
        }
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $google->id, 'external_id' => 'focus', 'title' => 'Deep work', 'starts_at' => $at('13:00'), 'ends_at' => $at('15:00')]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Deep work', 'starts_at' => $at('13:00'), 'ends_at' => $at('15:00'), 'kind' => 'flexible']);

        $occurrences = app(CalendarService::class)->occurrences($this->user, $at('00:00'), $at('23:59'));
        $this->assertSame(['quarterly review', 'Deep work'], $occurrences->pluck('title')->all());
        $this->assertSame('lifeos', $occurrences[1]['source'], 'the editable LifeOS copy wins');
        $this->assertCount(0, app(CalendarService::class)->conflicts($this->user, $at('10:15'), $at('10:45'))->where('source', 'outlook'));
    }

    public function test_google_tasks_import_read_only_and_copy_into_lifeos_without_duplicates(): void
    {
        $this->fakeGoogle();
        $account = $this->connect('google_tasks');
        $url = collect(Http::recorded())->map(fn ($pair) => $pair[0]->url())->first(fn ($u) => str_contains($u, 'tasks.googleapis.com/tasks/v1/lists/'));
        $this->assertStringContainsString('lists/L1/', $url, 'only the default list is read');
        $this->assertSame(['Renew passport'], ExternalTask::pluck('title')->all());
        $task = ExternalTask::firstOrFail();
        // Date-only due dates end that day in the user's timezone.
        $this->assertSame('2027-01-05 23:59', $task->due_at->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));

        $this->getJson('/api/connected/tasks')->assertOk()->assertJsonPath('0.source', 'Google Tasks')->assertJsonPath('0.url', 'https://tasks.google.com/task/t1');
        $this->getJson('/api/today')->assertOk()->assertJsonFragment(['type' => 'external', 'source' => 'Google Tasks', 'title' => 'Renew passport']);

        $copy = $this->postJson("/api/connected/tasks/{$task->id}/copy")->assertCreated()->json();
        $this->assertSame('google_tasks:L1|t1', Task::find($copy['id'])->source_ref);
        $this->postJson("/api/connected/tasks/{$task->id}/copy")->assertOk()->assertJsonPath('id', $copy['id']);
        $this->assertSame(1, Task::count());
        $this->getJson('/api/connected/tasks')->assertOk()->assertJsonCount(0);
        $today = collect($this->getJson('/api/today')->json('deadlines'));
        $this->assertSame(1, $today->where('title', 'Renew passport')->count(), 'shown once, as the LifeOS task');
        $this->assertSame('task', $today->firstWhere('title', 'Renew passport')['type']);

        $this->actingAs(User::factory()->create())->postJson("/api/connected/tasks/{$task->id}/copy")->assertNotFound();
        $this->actingAs($this->user)->deleteJson("/api/integrations/accounts/{$account->id}")->assertOk();
        $this->assertSame(0, ExternalTask::count());
        $this->assertSame(1, Task::count(), 'copied LifeOS tasks are kept');
        Http::assertNotSent(fn (HttpRequest $r) => $r->method() !== 'GET' && str_contains($r->url(), 'tasks.googleapis.com'));
    }

    public function test_todoist_uses_its_own_oauth_and_parses_dates_and_priorities(): void
    {
        Http::fake([
            'todoist.com/oauth/access_token' => Http::response(['access_token' => 'td-token', 'token_type' => 'Bearer']),
            'api.todoist.com/api/v1/user' => Http::response(['id' => '42', 'email' => 'me@todoist.test', 'full_name' => 'Me']),
            'api.todoist.com/api/v1/projects*' => Http::response(['results' => [['id' => 'inbox', 'name' => 'Inbox', 'inbox_project' => true], ['id' => 'p2', 'name' => 'Side project']], 'next_cursor' => null]),
            'api.todoist.com/api/v1/tasks*' => Http::response(['results' => [
                ['id' => '1', 'content' => 'Call bank', 'priority' => 4, 'due' => ['date' => '2027-01-06']],
                ['id' => '2', 'content' => 'Stand-up notes', 'priority' => 1, 'due' => ['date' => '2027-01-04T15:30:00', 'timezone' => null]],
                ['id' => '3', 'content' => 'Ticked', 'checked' => true],
            ], 'next_cursor' => null]),
        ]);
        $url = $this->postJson('/api/integrations/todoist/connect')->assertOk()->json('authorization_url');
        $this->assertStringStartsWith('https://todoist.com/oauth/authorize?', $url);
        $this->assertStringContainsString('scope=data%3Aread', $url);
        $account = $this->connect('todoist');
        $this->assertNull($account->token_expires_at);

        $tasks = ExternalTask::orderBy('external_id')->get();
        $this->assertSame(['Call bank', 'Stand-up notes'], $tasks->pluck('title')->all());
        $this->assertSame(['urgent', null], $tasks->pluck('priority')->all());
        $this->assertSame('2027-01-04 15:30', $tasks[1]->due_at->setTimezone('Europe/Amsterdam')->format('Y-m-d H:i'));
        $this->assertFalse($tasks[1]->due_is_date);
        Http::assertSent(fn (HttpRequest $r) => str_contains($r->url(), 'api/v1/tasks') && str_contains($r->url(), 'project_id=inbox'));
        Http::assertNotSent(fn (HttpRequest $r) => str_contains($r->url(), 'project_id=p2'));

        // Non-expiring tokens keep syncing without a refresh token.
        $this->postJson("/api/integrations/accounts/{$account->id}/sync")->assertOk()->assertJsonPath('account.status', 'active');
    }

    public function test_connected_titles_reach_an_external_ai_only_with_consent(): void
    {
        config(['ai.provider' => 'anthropic', 'ai.providers.anthropic.key' => 'test-key']);
        $account = CalendarAccount::create(['user_id' => $this->user->id, 'provider' => 'google', 'external_account_id' => 'g', 'access_token' => 'x', 'status' => 'active']);
        ExternalEvent::create(['user_id' => $this->user->id, 'calendar_account_id' => $account->id, 'external_id' => 'e', 'title' => 'Therapy session', 'starts_at' => now()->addDay(), 'ends_at' => now()->addDay()->addHour()]);
        CalendarEvent::create(['user_id' => $this->user->id, 'title' => 'Write report', 'starts_at' => now()->addDays(2), 'ends_at' => now()->addDays(2)->addHour()]);
        $inputs = [];
        Http::fake(['api.anthropic.com/*' => function (HttpRequest $request) use (&$inputs) {
            $inputs[] = $request['messages'][0]['content'];

            return Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => json_encode(['message' => 'Ok.', 'intent' => 'answer', 'schedule' => null, 'query' => null, 'target' => null, 'subtasks' => []])]]]);
        }]);

        $this->postJson('/api/assistant', ['message' => 'How does my week look?', 'language' => 'en'])->assertOk();
        $this->assertStringNotContainsString('Therapy session', $inputs[0]);
        $this->assertStringContainsString('Busy', $inputs[0]);
        $this->assertStringContainsString('Write report', $inputs[0]);

        $this->putJson('/api/settings', ['ai_connected_data' => true])->assertOk();
        $this->postJson('/api/assistant', ['message' => 'How does my week look?', 'language' => 'en'])->assertOk();
        $this->assertStringContainsString('Therapy session', $inputs[1]);
    }
}
