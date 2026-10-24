<?php

namespace App\Providers;

use App\Models\User;
use App\Services\CalendarService;
use App\Services\CalendarSyncService;
use Carbon\CarbonImmutable;
use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CalendarService::class);
    }

    public function boot(): void
    {
        ResetPassword::createUrlUsing(fn (object $user, string $token) => rtrim(config('app.frontend_url'), '/').'/reset-password?token='.urlencode($token).'&email='.urlencode($user->email));
        $this->configureRateLimiting();
        $this->app->make(CalendarService::class)->addSource(fn (User $user, CarbonImmutable $from, CarbonImmutable $to) => CalendarSyncService::occurrences($user->id, $from, $to));
    }

    /**
     * Named limiters keep separate counters, so the general API budget never consumes the stricter ones.
     */
    private function configureRateLimiting(): void
    {
        $identity = fn (Request $request): string => $request->user()?->id ? 'user:'.$request->user()->id : 'ip:'.$request->ip();
        RateLimiter::for('api', fn (Request $request) => Limit::perMinute(300)->by($identity($request)));
        RateLimiter::for('assistant', fn (Request $request) => Limit::perMinute(10)->by($identity($request)));
        RateLimiter::for('auth', fn (Request $request) => [
            Limit::perMinute(6)->by('auth:'.mb_strtolower((string) $request->input('email')).'|'.$request->ip()),
            Limit::perMinute(30)->by('auth-ip:'.$request->ip()),
        ]);
        RateLimiter::for('two-factor', fn (Request $request) => [
            // Keyed by the account being challenged so new sessions cannot reset the counter.
            Limit::perMinute(5)->by('2fa:'.($request->session()->get('login.challenge')['id'] ?? $request->user()?->id ?? $request->session()->getId())),
            Limit::perMinute(20)->by('2fa-ip:'.$request->ip()),
        ]);
        RateLimiter::for('password-reset', fn (Request $request) => Limit::perMinute(3)->by('reset:'.$request->ip()));
    }
}
