<?php

namespace App\Http\Controllers;

use App\Models\User;
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

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => 'required|email', 'password' => 'required|string']);
        if (! Auth::guard('web')->attempt($data)) {
            throw ValidationException::withMessages(['email' => ['The credentials do not match.']]);
        }
        $request->session()->regenerate();

        return response()->json($request->user());
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['message' => 'Signed out.']);
    }

    public function profile(Request $request): JsonResponse
    {
        $data = $request->validate(['name' => 'sometimes|required|string|max:100', 'email' => ['sometimes', 'required', 'email', 'max:255', Rule::unique('users')->ignore($request->user()->id)], 'current_password' => 'required_with:password|current_password', 'password' => ['sometimes', 'confirmed', PasswordRule::min(10)]]);
        unset($data['current_password']);
        $request->user()->update($data);
        if (isset($data['password'])) {
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
        $status = Password::reset($data, function (User $user, string $password): void {
            $user->forceFill(['password' => Hash::make($password), 'remember_token' => null])->save();
            DB::table('sessions')->where('user_id', $user->id)->delete();
        });
        if ($status !== Password::PASSWORD_RESET) {
            throw ValidationException::withMessages(['email' => [__($status)]]);
        }

        return response()->json(['message' => __($status)]);
    }

    public function sessions(Request $request): JsonResponse
    {
        return response()->json(DB::table('sessions')->where('user_id', $request->user()->id)->get(['id', 'user_agent', 'last_activity'])->map(fn ($s) => ['id' => hash('sha256', $s->id), 'user_agent' => $s->user_agent, 'last_activity' => $s->last_activity, 'current' => $s->id === $request->session()->getId()]));
    }

    public function revokeSessions(Request $request): JsonResponse
    {
        $request->validate(['password' => 'required|current_password']);
        DB::table('sessions')->where('user_id', $request->user()->id)->where('id', '!=', $request->session()->getId())->delete();

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
