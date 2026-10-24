<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\User;
use App\Services\TwoFactorService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class SecurityTest extends TestCase
{
    use RefreshDatabase;

    private function currentCode(string $secret, int $offsetSteps = 0): string
    {
        return app(TwoFactorService::class)->code($secret, intdiv(now()->getTimestamp(), 30) + $offsetSteps);
    }

    public function test_totp_matches_rfc_6238_vectors_and_rejects_replays(): void
    {
        $service = app(TwoFactorService::class);
        $secret = $service->base32Encode('12345678901234567890');
        $this->assertSame('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', $secret);
        foreach ([59 => '287082', 1111111109 => '081804', 1234567890 => '005924', 2000000000 => '279037'] as $time => $code) {
            $this->assertSame($code, $service->code($secret, intdiv($time, 30)));
            $this->assertSame(intdiv($time, 30), $service->matchStep($secret, $code, null, $time));
        }
        $this->assertNull($service->matchStep($secret, '287082', 1, 59));
        $this->assertNull($service->matchStep($secret, '28708', null, 59));
        $this->assertNull($service->matchStep($secret, '287082', null, 59 + 120));
    }

    public function test_enabling_two_factor_requires_recent_password_confirmation_and_a_valid_code(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user)->postJson('/api/security/two-factor')->assertStatus(423);
        $this->postJson('/api/security/confirm-password', ['password' => 'wrong'])->assertUnprocessable();
        $this->postJson('/api/security/confirm-password', ['password' => 'password'])->assertOk();

        $setup = $this->postJson('/api/security/two-factor')->assertOk()->json();
        $this->assertStringStartsWith('otpauth://totp/', $setup['otpauth_uri']);
        $this->assertStringContainsString('secret='.$setup['secret'], $setup['otpauth_uri']);
        $this->assertNotSame($setup['secret'], DB::table('users')->where('id', $user->id)->value('two_factor_secret'), 'secret must be encrypted at rest');

        $this->postJson('/api/security/two-factor/confirm', ['code' => '000000'])->assertUnprocessable();
        $codes = $this->postJson('/api/security/two-factor/confirm', ['code' => $this->currentCode($setup['secret'])])->assertOk()->json('recovery_codes');
        $this->assertCount(8, $codes);
        $this->assertTrue($user->fresh()->two_factor_enabled);
        $this->getJson('/api/user')->assertJsonPath('two_factor_enabled', true)->assertJsonMissingPath('two_factor_secret')->assertJsonMissingPath('two_factor_recovery_codes');
        $this->assertStringNotContainsString($codes[0], (string) DB::table('users')->where('id', $user->id)->value('two_factor_recovery_codes'));
        $this->getJson('/api/security')->assertJsonPath('recovery_codes_remaining', 8);
        $this->assertDatabaseHas('audit_logs', ['user_id' => $user->id, 'action' => 'two_factor_enabled']);
    }

    public function test_login_requires_the_second_factor_and_accepts_a_recovery_code_once(): void
    {
        $service = app(TwoFactorService::class);
        $user = User::factory()->create(['email' => 'secure@example.com']);
        $secret = $service->generateSecret();
        $user->forceFill(['two_factor_secret' => $secret, 'two_factor_confirmed_at' => now()])->save();
        $codes = $service->regenerateRecoveryCodes($user);

        $this->postJson('/api/login', ['email' => 'secure@example.com', 'password' => 'password'])->assertOk()->assertExactJson(['two_factor' => true]);
        $this->getJson('/api/user')->assertUnauthorized();
        $this->postJson('/api/two-factor-challenge', ['code' => '123456'])->assertUnprocessable();
        $this->getJson('/api/user')->assertUnauthorized();
        $code = $this->currentCode($secret);
        $this->postJson('/api/two-factor-challenge', ['code' => $code])->assertOk()->assertJsonPath('email', 'secure@example.com');
        $this->getJson('/api/user')->assertOk();
        $this->postJson('/api/logout')->assertOk();

        // The same TOTP code cannot be replayed.
        $this->postJson('/api/login', ['email' => 'secure@example.com', 'password' => 'password'])->assertJsonPath('two_factor', true);
        $this->postJson('/api/two-factor-challenge', ['code' => $code])->assertUnprocessable();
        $this->postJson('/api/two-factor-challenge', ['recovery_code' => strtoupper($codes[0])])->assertOk();
        $this->assertCount(7, $user->fresh()->two_factor_recovery_codes);
        $this->postJson('/api/logout');
        $this->postJson('/api/login', ['email' => 'secure@example.com', 'password' => 'password']);
        $this->postJson('/api/two-factor-challenge', ['recovery_code' => $codes[0]])->assertUnprocessable();

        $actions = AuditLog::where('user_id', $user->id)->pluck('action')->all();
        foreach (['login', 'two_factor_challenge_failed', 'recovery_code_used', 'logout'] as $action) {
            $this->assertContains($action, $actions);
        }
    }

    public function test_challenge_without_a_pending_login_or_after_expiry_fails(): void
    {
        $this->postJson('/api/two-factor-challenge', ['code' => '123456'])->assertUnprocessable()->assertJsonValidationErrors('code');
        $user = User::factory()->create(['email' => 'late@example.com']);
        $user->forceFill(['two_factor_secret' => app(TwoFactorService::class)->generateSecret(), 'two_factor_confirmed_at' => now()])->save();
        $this->postJson('/api/login', ['email' => 'late@example.com', 'password' => 'password'])->assertJsonPath('two_factor', true);
        $this->travel(6)->minutes();
        $this->postJson('/api/two-factor-challenge', ['code' => app(TwoFactorService::class)->code($user->fresh()->two_factor_secret, intdiv(now()->getTimestamp(), 30))])->assertUnprocessable();
    }

    public function test_challenge_is_rate_limited(): void
    {
        $user = User::factory()->create(['email' => 'rl@example.com']);
        $user->forceFill(['two_factor_secret' => app(TwoFactorService::class)->generateSecret(), 'two_factor_confirmed_at' => now()])->save();
        $this->postJson('/api/login', ['email' => 'rl@example.com', 'password' => 'password']);
        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/two-factor-challenge', ['code' => '000000'])->assertUnprocessable();
        }
        $this->postJson('/api/two-factor-challenge', ['code' => '000000'])->assertTooManyRequests();
    }

    public function test_disabling_two_factor_and_regenerating_codes_require_confirmation(): void
    {
        $user = User::factory()->create();
        $user->forceFill(['two_factor_secret' => app(TwoFactorService::class)->generateSecret(), 'two_factor_confirmed_at' => now()])->save();
        $this->actingAs($user)->postJson('/api/security/two-factor/recovery-codes')->assertStatus(423);
        $this->deleteJson('/api/security/two-factor')->assertStatus(423);
        $this->withSession(['auth.password_confirmed_at' => time()]);
        $this->postJson('/api/security/two-factor/recovery-codes')->assertOk()->assertJsonCount(8, 'recovery_codes');
        $this->deleteJson('/api/security/two-factor')->assertOk();
        $this->assertFalse($user->fresh()->two_factor_enabled);
        $this->assertNull($user->fresh()->two_factor_secret);
    }

    public function test_sessions_can_be_listed_and_revoked_individually(): void
    {
        $user = User::factory()->create();
        $other = User::factory()->create();
        DB::table('sessions')->insert([
            ['id' => 'phone-session', 'user_id' => $user->id, 'ip_address' => '10.0.0.2', 'user_agent' => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', 'payload' => '', 'last_activity' => time()],
            ['id' => 'someone-else', 'user_id' => $other->id, 'ip_address' => '10.0.0.3', 'user_agent' => 'x', 'payload' => '', 'last_activity' => time()],
        ]);
        $list = $this->actingAs($user)->getJson('/api/sessions')->assertOk()->json();
        $this->assertCount(1, $list);
        $this->assertSame('Safari · iOS', $list[0]['device']);
        $this->assertSame(hash('sha256', 'phone-session'), $list[0]['id']);

        $this->deleteJson('/api/sessions/'.hash('sha256', 'phone-session'))->assertStatus(423);
        $this->withSession(['auth.password_confirmed_at' => time()]);
        $this->deleteJson('/api/sessions/'.hash('sha256', 'someone-else'))->assertNotFound();
        $this->deleteJson('/api/sessions/'.hash('sha256', 'phone-session'))->assertOk();
        $this->assertDatabaseMissing('sessions', ['id' => 'phone-session']);
        $this->assertDatabaseHas('sessions', ['id' => 'someone-else']);
        $this->getJson('/api/security/audit-log')->assertOk()->assertJsonPath('data.0.action', 'session_revoked');
    }

    public function test_changing_email_requires_the_current_password(): void
    {
        $user = User::factory()->create(['email' => 'old@example.com']);
        $this->actingAs($user)->patchJson('/api/profile', ['email' => 'new@example.com'])->assertUnprocessable()->assertJsonValidationErrors('current_password');
        $this->patchJson('/api/profile', ['name' => 'Renamed', 'email' => 'OLD@example.com'])->assertOk();
        $this->patchJson('/api/profile', ['email' => 'new@example.com', 'current_password' => 'password'])->assertOk();
        $this->assertDatabaseHas('audit_logs', ['user_id' => $user->id, 'action' => 'email_changed']);
    }

    public function test_audit_log_is_private_and_failed_logins_are_recorded(): void
    {
        $user = User::factory()->create(['email' => 'victim@example.com']);
        $this->postJson('/api/login', ['email' => 'victim@example.com', 'password' => 'nope'])->assertUnprocessable();
        $this->assertDatabaseHas('audit_logs', ['user_id' => $user->id, 'action' => 'login_failed']);

        $this->actingAs(User::factory()->create())->getJson('/api/security/audit-log')->assertOk()->assertJsonCount(0, 'data');
    }
}
