<?php

namespace App\Providers;

use App\Integrations\Manifest\ManifestRegistry;
use App\Integrations\Vault\CredentialVault;
use App\Models\User;
use App\Services\CalendarService;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CalendarService::class);
        $this->app->singleton(ManifestRegistry::class);
        $this->app->singleton(CredentialVault::class);
    }

    public function boot(): void
    {
        ResetPassword::createUrlUsing(fn (object $user, string $token) => rtrim(config('app.frontend_url'), '/').'/reset-password?token='.urlencode($token).'&email='.urlencode($user->email));
        $this->configureRateLimiting();
        // Application-wide integration credentials are managed by LifeOS administrators only (users.is_admin, set with `php artisan lifeos:make-admin`).
        Gate::define('manage-integrations', fn (User $user): bool => (bool) $user->is_admin);
        $this->app->make(CalendarService::class)->addSource(fn (User $user, CarbonImmutable $from, CarbonImmutable $to) => CalendarSyncService::occurrences($user->id, $from, $to));
    }

    /**
     * Named limiters keep separate counters, so the general API budget never consumes the stricter ones.
     */
    private function configureRateLimiting(): void
    {
        $identity = fn (Request $request): string => $request->user()?->id ? 'user:'.$request->user()->id : 'ip:'.$request->ip();
        RateLimiter::for('api', fn (Request $request) => Limit::perMinute(max(1, (int) config('app.api_requests_per_minute', 300)))->by($identity($request)));
        RateLimiter::for('assistant', fn (Request $request) => Limit::perMinute(max(1, (int) config('ai.requests_per_minute', 10)))->by($identity($request)));
        RateLimiter::for('auth', fn (Request $request) => [
            Limit::perMinute(6)->by('auth:'.mb_strtolower((string) $request->input('email')).'|'.$request->ip()),
            Limit::perMinute(30)->by('auth-ip:'.$request->ip()),
        ]);
        RateLimiter::for('two-factor', fn (Request $request) => [
            // Keyed by the account being challenged so new sessions cannot reset the counter.
            Limit::perMinute(5)->by('2fa:'.($request->session()->get('login.challenge')['id'] ?? $request->user()?->id ?? $request->session()->getId())),
            Limit::perMinute(20)->by('2fa-ip:'.$request->ip()),
        ]);
        // Integration connect/callback traffic: counted per signed-in user (falling back to IP), separate from the sign-in limiter.
        RateLimiter::for('integrations', fn (Request $request) => [Limit::perMinute(30)->by('int:'.$identity($request)), Limit::perMinute(120)->by('int-ip:'.$request->ip())]);
        // Public webhook receiver: per endpoint+IP and per IP, so one noisy sender cannot starve the others.
        RateLimiter::for('webhooks', fn (Request $request) => [Limit::perMinute(120)->by('wh:'.$request->route('publicId').'|'.$request->ip()), Limit::perMinute(600)->by('wh-ip:'.$request->ip())]);
        RateLimiter::for('password-reset', fn (Request $request) => Limit::perMinute(3)->by('reset:'.$request->ip()));
    }
}
