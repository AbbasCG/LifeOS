<?php

return [
    /*
     * Product updates and feature discovery (Product Experience 2.0, P2). Nothing here holds a secret.
     * Content is reviewed JSON in resources/discovery/{releases,features,tours}; see docs/DISCOVERY.md.
     */

    // Directory of the content files. Null means resources/discovery.
    'path' => env('DISCOVERY_PATH'),

    /*
     * Updates reach people automatically: once a healthy deploy has written its success marker (`php artisan lifeos:discovery:check-marker` reports
     * whether the account running the scheduler can read it, read-only), the scheduler registers the release notes that shipped with the code. If the
     * marker cannot be read or does not match the running code, nothing is registered and nothing is shown: failing closed is automatic too.
     * This is also the kill switch: DISCOVERY_AUTO_ACTIVATE=false stops everything at once (what is already registered stays hidden).
     */
    'auto_activate' => (bool) env('DISCOVERY_AUTO_ACTIVATE', true),

    /*
     * A release registered by a healthy deploy is approved at once, without a person clicking. The review is the pull request that added the text: only
     * merged code (CI green, deployed, marker confirmed) can reach this point, the text is bound to its fingerprint (a later edit is a new approval, which this
     * also grants once that edit is deployed), and a release an administrator has WITHDRAWN is never approved again by this. Set DISCOVERY_AUTO_APPROVE=false to go
     * back to approving each release by hand on /admin/releases.
     */
    'auto_approve' => (bool) env('DISCOVERY_AUTO_APPROVE', true),

    /*
     * Who sees a newly registered release: "general" (everyone, the behaviour before staged rollout existed), "internal" (administrators and test accounts) or
     * "admin" (administrators only). An administrator widens it per release on /admin/releases. Releases already registered keep the stage they have.
     */
    'default_rollout' => env('DISCOVERY_DEFAULT_ROLLOUT', 'general'),

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
