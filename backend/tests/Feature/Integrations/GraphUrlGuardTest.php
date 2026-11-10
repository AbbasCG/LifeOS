<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\MicrosoftCalendarProvider;
use App\Integrations\Calendar\ProviderException;
use App\Integrations\Tasks\MicrosoftTodoProvider;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class GraphUrlGuardTest extends TestCase
{
    private const TOKEN = 'secret-bearer-token';

    /** @return array<string, array{string}> */
    public static function hostileLinks(): array
    {
        return [
            'suffix host' => ['https://graph.microsoft.com.evil.test/v1.0/next'],
            'other host' => ['https://evil.test/v1.0/next'],
            'userinfo' => ['https://graph.microsoft.com@evil.test/next'],
            'backslash' => ['https://evil.test\\@graph.microsoft.com/next'],
            'custom port' => ['https://graph.microsoft.com:8443/next'],
            'http' => ['http://graph.microsoft.com/next'],
            'scheme relative' => ['//evil.test/next'],
        ];
    }

    private function assertTokenStayedOnGraph(): void
    {
        Http::assertNotSent(fn (Request $r) => parse_url($r->url(), PHP_URL_HOST) !== 'graph.microsoft.com');
    }

    #[DataProvider('hostileLinks')]
    public function test_a_hostile_next_link_is_not_followed_by_the_calendar_provider(string $link): void
    {
        Http::fake(['https://graph.microsoft.com/*' => Http::response(['value' => [], '@odata.nextLink' => $link])]);
        try {
            app(MicrosoftCalendarProvider::class)->changes(self::TOKEN, 'cal1', null, CarbonImmutable::now(), CarbonImmutable::now()->addDay(), 'UTC');
            $this->fail('expected a ProviderException');
        } catch (ProviderException $e) {
            $this->assertStringNotContainsString('evil', $e->getMessage());
        }
        Http::assertSentCount(1);
        $this->assertTokenStayedOnGraph();
    }

    #[DataProvider('hostileLinks')]
    public function test_a_hostile_delta_link_is_refused_by_the_todo_provider(string $link): void
    {
        Http::fake(['https://graph.microsoft.com/*' => Http::response(['value' => [], '@odata.deltaLink' => $link])]);
        try {
            app(MicrosoftTodoProvider::class)->taskChanges(self::TOKEN, 'list1', null, 'UTC');
            $this->fail('expected a ProviderException');
        } catch (ProviderException $e) {
            $this->assertStringNotContainsString('evil', $e->getMessage());
        }
        Http::assertSentCount(1);
        $this->assertTokenStayedOnGraph();
    }

    public function test_a_hostile_next_link_is_not_followed_by_the_todo_provider(): void
    {
        Http::fake(['https://graph.microsoft.com/*' => Http::response(['value' => [], '@odata.nextLink' => 'https://graph.microsoft.com.evil.test/x'])]);
        $this->expectException(ProviderException::class);
        try {
            app(MicrosoftTodoProvider::class)->taskChanges(self::TOKEN, 'list1', null, 'UTC');
        } finally {
            Http::assertSentCount(1);
            $this->assertTokenStayedOnGraph();
        }
    }

    public function test_a_hostile_stored_sync_token_is_never_requested(): void
    {
        Http::fake();
        $this->expectException(ProviderException::class);
        try {
            app(MicrosoftCalendarProvider::class)->changes(self::TOKEN, 'cal1', 'https://graph.microsoft.com.evil.test/delta', CarbonImmutable::now(), CarbonImmutable::now()->addDay(), 'UTC');
        } finally {
            Http::assertNothingSent();
        }
    }

    public function test_legitimate_paging_and_delta_links_still_work(): void
    {
        Http::fake([
            'https://graph.microsoft.com/v1.0/me/todo/lists/list1/tasks/delta' => Http::response(['value' => [], '@odata.nextLink' => 'https://graph.microsoft.com/v1.0/page2']),
            'https://graph.microsoft.com/v1.0/page2' => Http::response(['value' => [], '@odata.deltaLink' => 'https://graph.microsoft.com/v1.0/delta?token=abc']),
        ]);
        $changes = app(MicrosoftTodoProvider::class)->taskChanges(self::TOKEN, 'list1', null, 'UTC');
        $this->assertSame('https://graph.microsoft.com/v1.0/delta?token=abc', $changes->nextToken);
        Http::assertSentCount(2);
    }
}
