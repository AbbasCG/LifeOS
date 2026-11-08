<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\GoogleCalendarProvider;
use App\Integrations\Calendar\ProviderException;
use App\Logging\RedactSecretsProcessor;
use App\Logging\RedactSecretsTap;
use App\Logging\SecretRedactor;
use App\Models\CalendarAccount;
use App\Models\SyncRun;
use App\Models\User;
use App\Services\CalendarSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Logger as LaravelLogger;
use Illuminate\Support\Facades\Http;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class SecretRedactionTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, array{string}> */
    public static function secretStrings(): array
    {
        return [
            'bearer header' => ['Authorization: Bearer ya29.A0AfH6SMBxxxxxxxxxxxxxxxx'],
            'basic header' => ['Authorization: Basic dXNlcjpwYXNzd29yZA=='],
            'json token' => ['{"access_token":"ya29.SECRETVALUE","expires_in":3600}'],
            'refresh token pair' => ['refresh_token=1//0gSECRETREFRESHVALUE&scope=x'],
            'client secret' => ['client_secret: GOCSPX-supersecretvalue'],
            'url parameter' => ['GET https://api.example.com/v1?api_key=abcdef123456&x=1'],
            'oauth code' => ['https://app.lifeos.test/cb?code=4/0AXSECRETCODE&state=abc123'],
            'jwt' => ['id_token eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl'],
            'verifier' => ['code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
        ];
    }

    #[DataProvider('secretStrings')]
    public function test_credentials_in_text_are_masked(string $text): void
    {
        $out = SecretRedactor::scrub($text);
        $this->assertStringContainsString('[REDACTED]', $out);
        foreach (['ya29', 'SECRET', 'GOCSPX', 'abcdef123456', 'dXNlcjpw', 'dBjftJe', 'eyJhbGci', '4/0AX'] as $needle) {
            $this->assertStringNotContainsString($needle, $out, $needle);
        }
    }

    public function test_ordinary_text_is_left_alone(): void
    {
        foreach (['The calendar server returned an error (500).', 'Reconnect the account.', 'Sync finished: 12 upserted, 0 removed.'] as $text) {
            $this->assertSame($text, SecretRedactor::scrub($text));
        }
    }

    public function test_structured_data_is_masked_by_key_at_any_depth(): void
    {
        $out = SecretRedactor::scrubArray(['user' => 5, 'access_token' => 'abc', 'nested' => ['Client_Secret' => 'x', 'ok' => 'fine', 'deeper' => ['password' => 'hunter2', 'note' => 'Bearer abcdefghij1234']]]);
        $this->assertSame([5, '[REDACTED]', '[REDACTED]', 'fine', '[REDACTED]', 'Bearer [REDACTED]'], [$out['user'], $out['access_token'], $out['nested']['Client_Secret'], $out['nested']['ok'], $out['nested']['deeper']['password'], $out['nested']['deeper']['note']]);
    }

    public function test_the_log_processor_masks_message_context_and_extra(): void
    {
        $handler = new TestHandler;
        $log = new Logger('t', [$handler], [new RedactSecretsProcessor]);
        $log->warning('refresh failed for Bearer abcdefghij123456', ['refresh_token' => 'RT-SECRET', 'response' => '{"access_token":"AT-SECRET"}']);
        $text = json_encode($handler->getRecords()[0]->toArray());
        foreach (['abcdefghij123456', 'RT-SECRET', 'AT-SECRET'] as $needle) {
            $this->assertStringNotContainsString($needle, $text);
        }
    }

    public function test_the_tap_is_installed_on_the_file_and_system_log_channels(): void
    {
        foreach (['single', 'daily', 'syslog', 'errorlog'] as $channel) {
            $this->assertContains(RedactSecretsTap::class, config("logging.channels.{$channel}.tap"), $channel);
        }
        $this->assertContains(RedactSecretsProcessor::class, config('logging.channels.stderr.processors'));

        $handler = new TestHandler;
        $logger = new LaravelLogger(new Logger('t', [$handler]));
        (new RedactSecretsTap)($logger);
        $logger->error('token leak', ['access_token' => 'LEAKED-VALUE']);
        $this->assertStringNotContainsString('LEAKED-VALUE', json_encode($handler->getRecords()[0]->toArray()));
    }

    public function test_provider_errors_stored_for_the_user_never_contain_credentials(): void
    {
        $user = User::factory()->create();
        $account = CalendarAccount::create(['user_id' => $user->id, 'provider' => 'google', 'external_account_id' => 'g', 'access_token' => 'x', 'refresh_token' => 'y', 'token_expires_at' => now()->addHour(), 'status' => 'active']);
        $run = SyncRun::create(['user_id' => $user->id, 'calendar_account_id' => $account->id, 'trigger' => 'manual', 'started_at' => now(), 'status' => 'running', 'mode' => 'full']);
        $run->finish('failed', 'Upstream said: {"access_token":"LEAK-ME","error":"boom"}');
        $this->assertStringNotContainsString('LEAK-ME', (string) $run->fresh()->error);

        config(['services.google_calendar' => ['client_id' => 'id', 'client_secret' => 's', 'redirect' => 'x']]);
        Http::fake(['*' => Http::response('boom', 500)]);
        $provider = $this->mock(GoogleCalendarProvider::class)->makePartial();
        $provider->shouldReceive('isConfigured')->andReturn(true);
        $provider->shouldReceive('collections')->andThrow(new ProviderException('failed with Bearer ya29.LEAKED-ACCESS-TOKEN and refresh_token=1//LEAKED-REFRESH'));
        $this->app->instance(GoogleCalendarProvider::class, $provider);
        try {
            app(CalendarSyncService::class)->sync($account->fresh(), 'manual');
        } catch (\Throwable) {
        }
        $stored = (string) $account->fresh()->last_error;
        $this->assertStringContainsString('failed with', $stored, 'the provider error was really stored (the path ran)');
        $this->assertStringNotContainsString('LEAKED', $stored);
        $this->assertStringContainsString('[REDACTED]', $stored);
    }
}
