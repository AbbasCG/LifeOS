<?php

namespace App\Http\Controllers;

use App\Models\AuditLog;
use App\Services\AuditLogger;
use App\Services\TwoFactorService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class SecurityController extends Controller
{
    public function __construct(private TwoFactorService $twoFactor, private AuditLogger $audit) {}

    /**
     * Start (or restart) a short password-confirmation window for sensitive actions.
     */
    public function confirmPassword(Request $request): JsonResponse
    {
        $request->validate(['password' => 'required|current_password']);
        $request->session()->passwordConfirmed();

        return response()->json(['confirmed_until' => now()->addSeconds(900)->toIso8601String()]);
    }

    public function overview(Request $request): JsonResponse
    {
        $user = $request->user();
        $confirmedAt = (int) $request->session()->get('auth.password_confirmed_at', 0);

        return response()->json([
            'two_factor_enabled' => $user->two_factor_enabled,
            'two_factor_pending' => ! $user->two_factor_enabled && $user->two_factor_secret !== null,
            'two_factor_confirmed_at' => $user->two_factor_confirmed_at?->toIso8601String(),
            'recovery_codes_remaining' => $user->two_factor_enabled ? count($user->two_factor_recovery_codes ?? []) : null,
            'password_confirmed' => $confirmedAt > 0 && time() - $confirmedAt < 900,
        ]);
    }

    public function enableTwoFactor(Request $request): JsonResponse
    {
        $user = $request->user();
        if ($user->two_factor_enabled) {
            throw ValidationException::withMessages(['two_factor' => ['Two-factor authentication is already enabled.']]);
        }
        $secret = $this->twoFactor->generateSecret();
        $user->forceFill(['two_factor_secret' => $secret, 'two_factor_recovery_codes' => null, 'two_factor_last_step' => null])->save();

        return response()->json(['secret' => $secret, 'otpauth_uri' => $this->twoFactor->otpauthUri($user, $secret)]);
    }

    public function confirmTwoFactor(Request $request): JsonResponse
    {
        $data = $request->validate(['code' => 'required|string|max:12']);
        $user = $request->user();
        if ($user->two_factor_enabled || ! $user->two_factor_secret) {
            throw ValidationException::withMessages(['code' => ['Start two-factor setup first.']]);
        }
        if (! $this->twoFactor->verify($user, $data['code'])) {
            throw ValidationException::withMessages(['code' => ['That code is not valid. Check your authenticator app’s time and try again.']]);
        }
        $user->forceFill(['two_factor_confirmed_at' => now()])->save();
        $codes = $this->twoFactor->regenerateRecoveryCodes($user);
        $this->audit->log($user, 'two_factor_enabled', $request);

        return response()->json(['recovery_codes' => $codes]);
    }

    public function regenerateRecoveryCodes(Request $request): JsonResponse
    {
        $user = $request->user();
        if (! $user->two_factor_enabled) {
            throw ValidationException::withMessages(['two_factor' => ['Two-factor authentication is not enabled.']]);
        }
        $codes = $this->twoFactor->regenerateRecoveryCodes($user);
        $this->audit->log($user, 'recovery_codes_regenerated', $request);

        return response()->json(['recovery_codes' => $codes]);
    }

    public function disableTwoFactor(Request $request): JsonResponse
    {
        $user = $request->user();
        $wasEnabled = $user->two_factor_enabled;
        $user->forceFill(['two_factor_secret' => null, 'two_factor_recovery_codes' => null, 'two_factor_confirmed_at' => null, 'two_factor_last_step' => null])->save();
        if ($wasEnabled) {
            $this->audit->log($user, 'two_factor_disabled', $request);
        }

        return response()->json(['message' => 'Two-factor authentication disabled.']);
    }

    public function sessions(Request $request): JsonResponse
    {
        $current = $request->session()->getId();

        return response()->json(DB::table('sessions')->where('user_id', $request->user()->id)->orderByDesc('last_activity')->get(['id', 'ip_address', 'user_agent', 'last_activity'])
            ->map(fn ($s) => ['id' => hash('sha256', $s->id), 'ip_address' => $s->ip_address, 'user_agent' => $s->user_agent, 'device' => $this->describeAgent((string) $s->user_agent), 'last_activity' => date(DATE_ATOM, (int) $s->last_activity), 'current' => $s->id === $current])
            ->values());
    }

    public function revokeSession(Request $request, string $hash): JsonResponse
    {
        abort_unless(preg_match('/^[a-f0-9]{64}$/', $hash) === 1, 404);
        $session = DB::table('sessions')->where('user_id', $request->user()->id)->get(['id'])->first(fn ($s) => hash_equals(hash('sha256', $s->id), $hash));
        abort_unless($session !== null, 404);
        if ($session->id === $request->session()->getId()) {
            throw ValidationException::withMessages(['session' => ['Use sign out to end the current session.']]);
        }
        DB::table('sessions')->where('id', $session->id)->where('user_id', $request->user()->id)->delete();
        $this->audit->log($request->user(), 'session_revoked', $request);

        return response()->json(['message' => 'Session revoked.']);
    }

    public function auditLog(Request $request): JsonResponse
    {
        return response()->json(AuditLog::where('user_id', $request->user()->id)->latest('created_at')->latest('id')->paginate(25)->through(fn (AuditLog $log) => [
            'id' => $log->id, 'action' => $log->action, 'ip_address' => $log->ip_address, 'device' => $this->describeAgent((string) $log->user_agent), 'meta' => $log->meta, 'created_at' => $log->created_at->toIso8601String(),
        ]));
    }

    /**
     * A short, human description such as "Chrome on macOS".
     */
    private function describeAgent(string $agent): string
    {
        $browser = match (true) {
            str_contains($agent, 'Edg/') => 'Edge',
            str_contains($agent, 'OPR/') => 'Opera',
            str_contains($agent, 'Firefox/') => 'Firefox',
            str_contains($agent, 'Chrome/') => 'Chrome',
            str_contains($agent, 'Safari/') => 'Safari',
            $agent === '' => 'Unknown',
            default => 'Browser',
        };
        $os = match (true) {
            str_contains($agent, 'iPhone') || str_contains($agent, 'iPad') => 'iOS',
            str_contains($agent, 'Android') => 'Android',
            str_contains($agent, 'Mac OS X') => 'macOS',
            str_contains($agent, 'Windows') => 'Windows',
            str_contains($agent, 'Linux') => 'Linux',
            default => null,
        };

        return $os ? "{$browser} · {$os}" : $browser;
    }
}
