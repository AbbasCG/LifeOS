<?php

namespace App\Integrations\Ai;

class AiProviders
{
    /** @var array<string, AiProvider> */
    private array $providers;

    public function __construct()
    {
        $this->providers = ['openai' => new OpenAiProvider, 'anthropic' => new AnthropicProvider];
    }

    /**
     * @return array<string, AiProvider>
     */
    public function all(): array
    {
        return $this->providers;
    }

    /**
     * The provider selected by AI_PROVIDER when it has credentials; null means the local assistant answers.
     */
    public function active(): ?AiProvider
    {
        $provider = $this->providers[(string) config('ai.provider')] ?? null;

        return $provider?->isConfigured() ? $provider : null;
    }
}
