<?php

return [
    /*
     * The demo seeder only runs when this is explicitly true AND the app environment is local or testing.
     * It is never enabled by default and refuses to run in production regardless of this flag.
     */
    'enabled' => (bool) env('LIFEOS_DEMO_ENABLED', false),
    'email' => env('LIFEOS_DEMO_EMAIL', 'demo@lifeos.local'),
    // Optional. When empty, a random password is generated and printed once by `php artisan lifeos:demo`.
    'password' => env('LIFEOS_DEMO_PASSWORD'),
    'timezone' => env('LIFEOS_DEMO_TIMEZONE', 'Europe/Amsterdam'),
];
