<?php

namespace App\Integrations\Manifest;

/**
 * The single list of integrations LifeOS knows about, loaded from resources/integrations/*.json and validated.
 * Adding a provider means adding one manifest (and, when it is available, a connector class) - no other list to edit.
 */
class ManifestRegistry
{
    /** Category key => display names. */
    public const CATEGORIES = [
        'calendars' => ['en' => 'Calendars', 'ar' => 'التقويمات'],
        'tasks' => ['en' => 'Tasks', 'ar' => 'المهام'],
        'productivity' => ['en' => 'Notes & boards', 'ar' => 'الملاحظات واللوحات'],
        'developer' => ['en' => 'Developer tools', 'ar' => 'أدوات المطورين'],
        'messaging' => ['en' => 'Messaging', 'ar' => 'المراسلة'],
        'ai' => ['en' => 'AI providers', 'ar' => 'مزودو الذكاء الاصطناعي'],
        'automation' => ['en' => 'Automation', 'ar' => 'الأتمتة'],
        'custom' => ['en' => 'Custom systems', 'ar' => 'أنظمة مخصصة'],
    ];

    public const AUTH_TYPES = ['oauth2_pkce', 'oauth2', 'api_key', 'webhook', 'ics', 'custom'];

    /** @var array<string, ProviderManifest>|null */
    private ?array $manifests = null;

    public function __construct(private ?string $directory = null) {}

    /** @return array<string, ProviderManifest> keyed by provider id, in file order */
    public function all(): array
    {
        return $this->manifests ??= $this->load();
    }

    public function find(string $id): ?ProviderManifest
    {
        return $this->all()[$id] ?? null;
    }

    /** @return list<string> ids of providers that can be connected today */
    public function availableIds(): array
    {
        return array_keys(array_filter($this->all(), fn (ProviderManifest $m) => $m->isAvailable()));
    }

    /**
     * @return array<string, ProviderManifest>
     */
    private function load(): array
    {
        $directory = $this->directory ?? resource_path('integrations');
        $files = glob($directory.'/*.json') ?: [];
        sort($files);
        $manifests = [];
        foreach ($files as $file) {
            $data = json_decode((string) file_get_contents($file), true);
            if (! is_array($data)) {
                throw new InvalidManifestException(basename($file).' is not valid JSON.');
            }
            $this->validate($data, basename($file, '.json'));
            $manifests[$data['id']] = new ProviderManifest($data);
        }

        return $manifests;
    }

    /**
     * @param  array<string, mixed>  $data
     */
    private function validate(array $data, string $filename): void
    {
        $id = $data['id'] ?? null;
        $fail = fn (string $why) => throw new InvalidManifestException("Manifest {$filename}: {$why}");
        if (! is_string($id) || ! preg_match('/^[a-z][a-z0-9_]{1,39}$/', $id)) {
            $fail('id must be 2-40 lowercase letters, digits or underscores.');
        }
        if ($id !== $filename) {
            $fail('the file name must equal the id.');
        }
        if (! isset(self::CATEGORIES[$data['category'] ?? ''])) {
            $fail('unknown category.');
        }
        if (! in_array($data['auth'] ?? null, self::AUTH_TYPES, true)) {
            $fail('unknown auth type.');
        }
        if (! in_array($data['status'] ?? null, ['available', 'planned'], true)) {
            $fail('status must be available or planned.');
        }
        foreach (['name', 'description'] as $field) {
            foreach (['en', 'ar'] as $lang) {
                if (! is_string($data[$field][$lang] ?? null) || trim($data[$field][$lang]) === '') {
                    $fail("{$field}.{$lang} is required.");
                }
            }
        }
        foreach (['multi_account', 'requires_admin_setup'] as $flag) {
            if (! is_bool($data[$flag] ?? null)) {
                $fail("{$flag} must be true or false.");
            }
        }
        if (! is_array($data['capabilities'] ?? null) || ! is_array($data['scopes'] ?? null)) {
            $fail('capabilities and scopes must be lists.');
        }
        foreach ($data['scopes'] as $scope) {
            if (! is_string($scope['id'] ?? null) || ! is_bool($scope['required'] ?? null) || ! is_string($scope['label']['en'] ?? null) || ! is_string($scope['label']['ar'] ?? null)) {
                $fail('every scope needs id, required and label.en/label.ar.');
            }
        }
        if (isset($data['docs_url']) && ! preg_match('~^https://~', (string) $data['docs_url'])) {
            $fail('docs_url must be https.');
        }
    }
}
