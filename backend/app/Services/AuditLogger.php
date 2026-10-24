<?php

namespace App\Services;

use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Http\Request;

/**
 * Records security-relevant account actions. Never stores secrets, tokens or passwords.
 */
class AuditLogger
{
    public const ACTIONS = [
        'login', 'login_failed', 'logout', 'password_changed', 'email_changed', 'password_reset',
        'two_factor_enabled', 'two_factor_disabled', 'two_factor_challenge_failed', 'recovery_codes_regenerated', 'recovery_code_used',
        'session_revoked', 'other_sessions_revoked', 'data_exported',
        'integration_connected', 'integration_disconnected', 'integration_revoked', 'integration_collections_changed', 'connected_task_copied',
        'push_subscribed', 'push_unsubscribed', 'ai_action_executed', 'automation_changed', 'checkins_deleted',
    ];

    /**
     * @param  array<string, scalar|null>  $meta
     */
    public function log(User $user, string $action, ?Request $request = null, array $meta = []): AuditLog
    {
        $request ??= request();

        return AuditLog::create([
            'user_id' => $user->id,
            'action' => $action,
            'ip_address' => $request?->ip(),
            'user_agent' => $request ? mb_substr((string) $request->userAgent(), 0, 255) : null,
            'meta' => $meta ?: null,
        ]);
    }
}
