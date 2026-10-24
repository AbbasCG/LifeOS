<?php

namespace App\Integrations\Ai;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;

/**
 * Claude through the Messages API with structured JSON output. Uses Laravel's HTTP client so no SDK dependency is added.
 */
class AnthropicProvider implements AiProvider
{
    public const API_VERSION = '2026-10-21';

    public function name(): string
    {
        return 'anthropic';
    }

    public function label(): string
    {
        return 'Anthropic Claude';
    }

    public function model(): string
    {
        return (string) config('ai.providers.anthropic.model');
    }

    public function isConfigured(): bool
    {
        return filled(config('ai.providers.anthropic.key'));
    }

    public function json(string $system, string $input, array $schema): array
    {
        $headers = ['x-api-key' => (string) config('ai.providers.anthropic.key'), 'anthropic-version' => self::API_VERSION];
        $body = [
            'model' => $this->model(),
            'max_tokens' => 16000,
            'system' => $system,
            'messages' => [['role' => 'user', 'content' => $input]],
            'output_config' => ['effort' => (string) config('ai.providers.anthropic.effort'), 'format' => ['type' => 'json_schema', 'schema' => $schema]],
        ];
        if (config('ai.providers.anthropic.fallbacks')) {
            $headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
            $body['fallbacks'] = 'default';
        }
        try {
            $response = Http::withHeaders($headers)->timeout((int) config('ai.timeout'))->post('https://api.anthropic.com/v1/messages', $body);
        } catch (ConnectionException $e) {
            throw new AiException('Claude could not be reached.', 0, $e);
        }
        if ($response->failed()) {
            throw new AiException("Claude returned HTTP {$response->status()}.");
        }
        $stop = $response->json('stop_reason');
        if ($stop === 'refusal') {
            throw new AiException('Claude declined this request.');
        }
        if ($stop === 'max_tokens') {
            throw new AiException('Claude’s answer was cut off.');
        }
        $text = collect($response->json('content', []))->where('type', 'text')->pluck('text')->implode('');
        $data = json_decode($text, true);
        if (! is_array($data)) {
            throw new AiException('Claude returned an unreadable answer.');
        }

        return $data;
    }
}
