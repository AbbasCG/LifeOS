<?php

namespace App\Integrations\Manifest;

/**
 * Declarative description of one integration (what it is, how it authenticates, what it can do). Behaviour lives in
 * connector classes; this is data that can be reviewed without reading code and contains no secrets.
 */
final class ProviderManifest
{
    /** @param array<string, mixed> $data validated by ManifestRegistry */
    public function __construct(public readonly array $data) {}

    public function id(): string
    {
        return $this->data['id'];
    }

    public function category(): string
    {
        return $this->data['category'];
    }

    public function auth(): string
    {
        return $this->data['auth'];
    }

    public function isAvailable(): bool
    {
        return $this->data['status'] === 'available';
    }

    public function requiresAdminSetup(): bool
    {
        return (bool) $this->data['requires_admin_setup'];
    }

    /** @return array<string, mixed> Safe to send to the browser. */
    public function toPublic(): array
    {
        return [
            'id' => $this->id(),
            'category' => $this->category(),
            'auth' => $this->auth(),
            'status' => $this->data['status'],
            'name' => $this->data['name'],
            'description' => $this->data['description'],
            'scopes' => $this->data['scopes'],
            'capabilities' => $this->data['capabilities'],
            'multi_account' => (bool) $this->data['multi_account'],
            'requires_admin_setup' => $this->requiresAdminSetup(),
            'docs_url' => $this->data['docs_url'] ?? null,
            'logo' => $this->data['logo'] ?? null,
        ];
    }
}
