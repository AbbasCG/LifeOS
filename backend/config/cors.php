<?php

/*
 * The SPA is served from the same origin as the API, so no foreign origin
 * is allowed by default. List trusted origins in CORS_ALLOWED_ORIGINS
 * (comma separated) only for a split deployment.
 */
return [
    'paths' => ['api/*', 'sanctum/csrf-cookie'],
    'allowed_methods' => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    'allowed_origins' => array_values(array_filter(array_map('trim', explode(',', (string) env('CORS_ALLOWED_ORIGINS', ''))))),
    'allowed_origins_patterns' => [],
    'allowed_headers' => ['Accept', 'Content-Type', 'X-Requested-With', 'X-XSRF-TOKEN', 'Authorization'],
    'exposed_headers' => [],
    'max_age' => 600,
    'supports_credentials' => true,
];
