<?php

namespace App\Integrations\Ai;

/**
 * A language model that turns a request plus authorized context into a JSON object matching a schema.
 * Providers only interpret and explain; they never touch the database.
 */
interface AiProvider
{
    public function name(): string;

    public function label(): string;

    public function model(): string;

    public function isConfigured(): bool;

    /**
     * @param  array<string, mixed>  $schema  JSON schema of the expected object
     * @return array<string, mixed>
     *
     * @throws AiException
     */
    public function json(string $system, string $input, array $schema): array;
}
