<?php

return [
    /*
     * Integrations core. Nothing here holds a secret: provider credentials live in the encrypted
     * integration_app_credentials table (or in the existing services.* environment values as a fallback).
     */

    // OAuth authorization state lifetime, in seconds.
    'oauth_state_ttl' => 600,

    // How long a request waits for another process that is refreshing the same account's token.
    'refresh_lock_wait' => 10,

    // Administrators must have two-factor authentication enabled (and a fresh password confirmation) to change credentials.
    'admin_requires_two_factor' => (bool) env('INTEGRATIONS_ADMIN_REQUIRES_2FA', true),

    'webhooks' => [
        'max_bytes' => 1024 * 1024,
        // A signed request older (or newer) than this is rejected, which limits replay.
        'tolerance_seconds' => 300,
        // After a secret rotation the previous secret keeps working for this long.
        'secret_overlap_hours' => 24,
        'retention_days' => 7,
    ],

    // Manifest provider id => the config/services.php key that holds its OAuth client (environment fallback).
    'credential_map' => [
        'google' => 'google_calendar',
        'outlook' => 'microsoft_calendar',
        'google_tasks' => 'google_tasks',
        'microsoft_todo' => 'microsoft_todo',
        'todoist' => 'todoist',
    ],
];
