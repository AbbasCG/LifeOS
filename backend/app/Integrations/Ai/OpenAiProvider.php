<?php

namespace App\Integrations\Ai;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;

class OpenAiProvider implements AiProvider
{
    public function name(): string
    {
        return 'openai';
    }

    public function label(): string
    {
        return 'OpenAI';
    }

    public function model(): string
    {
        return (string) config('ai.providers.openai.model');
    }

    public function isConfigured(): bool
    {
        return filled(config('ai.providers.openai.key'));
    }

    public function json(string $system, string $input, array $schema): array
    {
        try {
            $response = Http::withToken((string) config('ai.providers.openai.key'))->timeout((int) config('ai.timeout'))->post('https://api.openai.com/v1/chat/completions', [
                'model' => $this->model(),
                'messages' => [
                    ['role' => 'system', 'content' => $system."\nReturn only a JSON object matching this JSON schema:\n".json_encode($schema)],
                    ['role' => 'user', 'content' => $input],
                ],
                'response_format' => ['type' => 'json_object'],
            ]);
        } catch (ConnectionException $e) {
            throw new AiException('OpenAI could not be reached.', 0, $e);
        }
        if ($response->failed()) {
            throw new AiException("OpenAI returned HTTP {$response->status()}.");
        }
        $data = json_decode((string) $response->json('choices.0.message.content', ''), true);
        if (! is_array($data)) {
            throw new AiException('OpenAI returned an unreadable answer.');
        }

        return $data;
    }
}
