<?php

return [
    /*
     * Product updates and feature discovery (Product Experience 2.0, P2). Nothing here holds a secret.
     * Content is reviewed JSON in resources/discovery/{releases,features,tours}; see docs/DISCOVERY.md.
     */

    // Directory of the content files. Null means resources/discovery.
    'path' => env('DISCOVERY_PATH'),

    /*
     * Activation is OFF until the owner has checked that the account running the scheduler can read the deploy-success marker
     * (`php artisan lifeos:discovery:check-marker` reports it, read-only). While it is off no release is ever registered, so
     * nothing can be shown to users: the safe default.
     */
    'auto_activate' => (bool) env('DISCOVERY_AUTO_ACTIVATE', false),

    // Written by scripts/deploy-production.sh only after the health checks passed; holds the 40-character commit that is live.
    'deploy_marker' => env('DISCOVERY_DEPLOY_MARKER', '/var/lib/lifeos-deploy/current.sha'),

    // The git checkout that the marker is compared with (the running code). Null means the parent of backend/.
    'repository_path' => env('DISCOVERY_REPOSITORY_PATH'),

    // Approving and withdrawing releases needs an administrator (users.is_admin) with two-factor authentication on.
    'admin_requires_two_factor' => (bool) env('DISCOVERY_ADMIN_REQUIRES_2FA', true),

    // "Later" hides an announcement for this long; after this many postponements it moves to the update history only.
    'snooze_hours' => 24,
    'max_snoozes' => 2,

    // Feature requirements of the form "config:<name>" read these boolean settings (name => config key).
    'flags' => [
        'calendar_write' => 'calendar_write.enabled',
    ],

    // Size limits checked by `lifeos:discovery:validate` for files under frontend/public/discovery.
    'max_image_bytes' => 512 * 1024,
    'max_video_bytes' => 3 * 1024 * 1024,
];
