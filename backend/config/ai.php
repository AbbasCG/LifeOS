<?php

return [
    // disabled | openai | anthropic. Anything else (or missing credentials) uses the built-in local assistant.
    'provider' => env('AI_PROVIDER', 'disabled'),
    'timeout' => (int) env('AI_TIMEOUT', 60),
    'providers' => [
        'openai' => ['key' => env('OPENAI_API_KEY', env('AI_API_KEY')), 'model' => env('OPENAI_MODEL', env('AI_MODEL', 'gpt-4.1-mini'))],
        'anthropic' => ['key' => env('ANTHROPIC_API_KEY'), 'model' => env('ANTHROPIC_MODEL', 'claude-opus-5-5'), 'effort' => env('ANTHROPIC_EFFORT', 'medium'), 'fallbacks' => (bool) env('ANTHROPIC_FALLBACKS', true)],
    ],
];
