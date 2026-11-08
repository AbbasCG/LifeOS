<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Symfony\Component\HttpFoundation\Response;

/**
 * Guards the integration administration routes: the user must be a LifeOS administrator (403 otherwise), and a change
 * (anything but a read) additionally needs two-factor authentication to be switched on. Put password.confirm after it.
 */
class EnsureIntegrationAdmin
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! Gate::allows('manage-integrations')) {
            return response()->json(['message' => 'This action is only available to LifeOS administrators.', 'code' => 'admin_required'], 403);
        }
        if (! $request->isMethodSafe() && config('integrations.admin_requires_two_factor') && ! $request->user()->two_factor_enabled) {
            return response()->json(['message' => 'Turn on two-factor authentication before changing integration credentials.', 'code' => 'two_factor_required'], 403);
        }

        return $next($request);
    }
}
