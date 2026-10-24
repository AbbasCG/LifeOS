<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Resend, Postmark, AWS, and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    /*
     * Read-only calendar integrations. Leave the client id empty to keep a provider disabled.
     * Redirect URIs must be registered with the provider exactly as configured here.
     */
    'google_calendar' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
        'redirect' => env('GOOGLE_REDIRECT_URI', rtrim((string) env('FRONTEND_URL', 'http://localhost:5173'), '/').'/api/integrations/google/callback'),
    ],

    // Task services reuse the Google / Microsoft OAuth clients with their own redirect URI and narrower read-only scopes.
    'google_tasks' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
        'redirect' => env('GOOGLE_TASKS_REDIRECT_URI', rtrim((string) env('FRONTEND_URL', 'http://localhost:5173'), '/').'/api/integrations/google_tasks/callback'),
    ],

    'microsoft_todo' => [
        'client_id' => env('MICROSOFT_CLIENT_ID'),
        'client_secret' => env('MICROSOFT_CLIENT_SECRET'),
        'tenant' => env('MICROSOFT_TENANT', 'common'),
        'redirect' => env('MICROSOFT_TODO_REDIRECT_URI', rtrim((string) env('FRONTEND_URL', 'http://localhost:5173'), '/').'/api/integrations/microsoft_todo/callback'),
    ],

    'todoist' => [
        'client_id' => env('TODOIST_CLIENT_ID'),
        'client_secret' => env('TODOIST_CLIENT_SECRET'),
        'redirect' => env('TODOIST_REDIRECT_URI', rtrim((string) env('FRONTEND_URL', 'http://localhost:5173'), '/').'/api/integrations/todoist/callback'),
    ],

    'microsoft_calendar' => [
        'client_id' => env('MICROSOFT_CLIENT_ID'),
        'client_secret' => env('MICROSOFT_CLIENT_SECRET'),
        'tenant' => env('MICROSOFT_TENANT', 'common'),
        'redirect' => env('MICROSOFT_REDIRECT_URI', rtrim((string) env('FRONTEND_URL', 'http://localhost:5173'), '/').'/api/integrations/outlook/callback'),
    ],

    'webpush' => [
        // Generate with `php artisan lifeos:vapid-keys`. Without these, push stays disabled and in-app notifications still work.
        'public_key' => env('VAPID_PUBLIC_KEY'),
        'private_key' => env('VAPID_PRIVATE_KEY'),
        'subject' => env('VAPID_SUBJECT'),
        'allowed_hosts' => explode(',', (string) env('PUSH_ALLOWED_HOSTS', 'fcm.googleapis.com,updates.push.services.mozilla.com,push.services.mozilla.com,notify.windows.com,push.apple.com')),
    ],

];
