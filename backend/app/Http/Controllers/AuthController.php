<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\AuditLogger;
use App\Services\TwoFactorService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Password;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Rules\Password as PasswordRule;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function register(Request $request): JsonResponse
    {
        $data = $request->validate(['name' => 'required|string|max:100', 'email' => 'required|email|max:255|unique:users', 'password' => ['required', 'confirmed', PasswordRule::min(10)]]);
        $user = User::create($data);
        Auth::guard('web')->login($user);
        $request->session()->regenerate();

        return response()->json($user, 201);
    }

    public const CHALLENGE_TTL = 300;

    public function login(Request $request, AuditLogger $audit): JsonResponse
    {
        $data = $request->validate(['email' => 'required|email', 'password' => 'required|string', 'remember' => 'sometimes|boolean']);
        $guard = Auth::guard('web');
        if (! $guard->validate(['email' => $data['email'], 'password' => $data['password']])) {
            if ($user = User::where('email', $data['email'])->first()) {
                $audit->log($user, 'login_failed', $request);
            }
            throw ValidationException::withMessages(['email' => ['The credentials do not match.']]);
        }
        $user = User::where('email', $data['email'])->firstOrFail();
        if ($user->two_factor_enabled) {
            // Password is correct but no session is established until the second factor is verified.
            $request->session()->put('login.challenge', ['id' => $user->id, 'remember' => (bool) ($data['remember'] ?? false), 'expires' => now()->getTimestamp() + self::CHALLENGE_TTL]);

            return response()->json(['two_factor' => true]);
        }
        $guard->login($user, (bool) ($data['remember'] ?? false));
        $request->session()->regenerate();
        $audit->log($user, 'login', $request, ['method' => 'password']);

        return response()->json($user);
    }

    public function twoFactorChallenge(Request $request, TwoFactorService $twoFactor, AuditLogger $audit): JsonResponse
    {
        $data = $request->validate(['code' => 'nullable|string|max:12|required_without:recovery_code', 'recovery_code' => 'nullable|string|max:32']);
        $pending = $request->session()->get('login.challenge');
        if (! $pending || $pending['expires'] < now()->getTimestamp() || ! ($user = User::find($pending['id'])) || ! $user->two_factor_enabled) {
            $request->session()->forget('login.challenge');
            throw ValidationException::withMessages(['code' => ['Your sign-in attempt expired. Enter your email and password again.']]);
        }
        $usedRecovery = ! empty($data['recovery_code']);
        $valid = $usedRecovery ? $twoFactor->useRecoveryCode($user, $data['recovery_code']) : $twoFactor->verify($user, $data['code']);
        if (! $valid) {
            $audit->log($user, 'two_factor_challenge_failed', $request);
            throw ValidationException::withMessages([$usedRecovery ? 'recovery_code' : 'code' => ['That code is not valid.']]);
        }
        $request->session()->forget('login.challenge');
        Auth::guard('web')->login($user, $pending['remember']);
        $request->session()->regenerate();
        $audit->log($user, 'login', $request, ['method' => $usedRecovery ? 'recovery_code' : 'totp']);
        if ($usedRecovery) {
            $audit->log($user, 'recovery_code_used', $request, ['remaining' => count($user->two_factor_recovery_codes ?? [])]);
        }

        return response()->json($user);
    }

    public function logout(Request $request, AuditLogger $audit): JsonResponse
    {
        $audit->log($request->user(), 'logout', $request);
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['message' => 'Signed out.']);
    }

    public function profile(Request $request, AuditLogger $audit): JsonResponse
    {
        $user = $request->user();
        $emailChanging = $request->filled('email') && mb_strtolower($request->input('email')) !== mb_strtolower($user->email);
        $data = $request->validate(['name' => 'sometimes|required|string|max:100', 'email' => ['sometimes', 'required', 'email', 'max:255', Rule::unique('users')->ignore($user->id)], 'current_password' => [$emailChanging ? 'required' : 'required_with:password', 'current_password'], 'password' => ['sometimes', 'confirmed', PasswordRule::min(10)]]);
        unset($data['current_password']);
        $user->update($data);
        if ($emailChanging) {
            $audit->log($user, 'email_changed', $request);
        }
        if (isset($data['password'])) {
            $audit->log($user, 'password_changed', $request);
            DB::table('sessions')->where('user_id', $request->user()->id)->where('id', '!=', $request->session()->getId())->delete();
            $request->session()->regenerate();
        }

        return response()->json($request->user());
    }

    public function forgot(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => 'required|email']);
        Password::sendResetLink($data);

        return response()->json(['message' => 'If the account exists, a password reset link has been sent.']);
    }

    public function reset(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => 'required|email', 'token' => 'required|string', 'password' => ['required', 'confirmed', PasswordRule::min(10)]]);
        $status = Password::reset($data, function (User $user, string $password) use ($request): void {
            $user->forceFill(['password' => Hash::make($password), 'remember_token' => null])->save();
            DB::table('sessions')->where('user_id', $user->id)->delete();
            app(AuditLogger::class)->log($user, 'password_reset', $request);
        });
        if ($status !== Password::PASSWORD_RESET) {
            throw ValidationException::withMessages(['email' => [__($status)]]);
        }

        return response()->json(['message' => __($status)]);
    }

    public function revokeSessions(Request $request, AuditLogger $audit): JsonResponse
    {
        $request->validate(['password' => 'required|current_password']);
        DB::table('sessions')->where('user_id', $request->user()->id)->where('id', '!=', $request->session()->getId())->delete();
        $audit->log($request->user(), 'other_sessions_revoked', $request);

        return response()->json(['message' => 'Other sessions revoked.']);
    }

    public function destroy(Request $request): JsonResponse
    {
        $request->validate(['password' => 'required|current_password']);
        $user = $request->user();
        $this->logout($request);
        DB::transaction(function () use ($user): void {
            DB::table('sessions')->where('user_id', $user->id)->delete();
            $user->delete();
        });

        return response()->json(['message' => 'Account deleted.']);
    }
}
