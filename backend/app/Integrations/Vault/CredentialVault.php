<?php

namespace App\Integrations\Vault;

use App\Integrations\Manifest\ManifestRegistry;
use App\Models\AppCredential;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Where an integration's OAuth client credentials come from. A complete administrator-set record in the database
 * (client id + encrypted secret) wins; otherwise the existing services.* environment values are used. The two sources
 * are never mixed field by field. Secrets are write-only: nothing here returns one to the API.
 */
class CredentialVault
{
    /** @var array<string, AppCredential|false> per-process cache */
    private array $rows = [];

    public function __construct(private ManifestRegistry $manifests) {}

    /**
     * The credentials a provider's OAuth client should use: $base is its services.* config.
     *
     * @param  array<string, mixed>  $base
     * @return array<string, mixed>
     */
    public function overlay(string $configKey, array $base): array
    {
        $provider = array_search($configKey, (array) config('integrations.credential_map'), true);
        $row = is_string($provider) ? $this->row($provider) : null;
        if (! $row || ! $this->complete($row)) {
            return $base;
        }
        $base['client_id'] = $row->client_id;
        $base['client_secret'] = $row->client_secret;
        if ($row->redirect_uri) {
            $base['redirect'] = $row->redirect_uri;
        }

        return $base;
    }

    /** 'database', 'environment' or 'none'. */
    public function source(string $provider): string
    {
        $row = $this->row($provider);
        if ($row && $this->complete($row)) {
            return 'database';
        }
        $env = (array) config('services.'.(config('integrations.credential_map')[$provider] ?? '_'), []);

        return ! empty($env['client_id']) && ! empty($env['client_secret']) ? 'environment' : 'none';
    }

    /**
     * Status for the admin screen. Never contains the secret.
     *
     * @return array<string, mixed>
     */
    public function status(string $provider): array
    {
        $row = $this->row($provider);
        $source = $this->source($provider);
        $env = (array) config('services.'.(config('integrations.credential_map')[$provider] ?? '_'), []);

        return [
            'provider' => $provider,
            'configured' => $source !== 'none',
            'source' => $source,
            'client_id' => $source === 'database' ? $row->client_id : null,
            'has_secret' => $source !== 'none',
            'redirect_uri' => $source === 'database' && $row->redirect_uri ? $row->redirect_uri : ($env['redirect'] ?? null),
            'rotated_at' => $row?->rotated_at?->toIso8601String(),
        ];
    }

    public function store(string $provider, string $clientId, ?string $clientSecret, ?string $redirectUri, User $admin): AppCredential
    {
        $row = AppCredential::firstOrNew(['provider_key' => $provider]);
        $row->client_id = $clientId;
        if ($clientSecret !== null && $clientSecret !== '') {
            $row->client_secret = $clientSecret;
            $row->rotated_at = now();
        }
        $row->redirect_uri = $redirectUri ?: null;
        $row->enabled = true;
        $row->set_by = $admin->id;
        $row->save();
        unset($this->rows[$provider]);

        return $row;
    }

    public function forget(string $provider): bool
    {
        unset($this->rows[$provider]);

        return AppCredential::where('provider_key', $provider)->delete() > 0;
    }

    public function hasSecret(string $provider): bool
    {
        $row = $this->row($provider);

        return $row !== null && $row->client_secret !== null && $row->client_secret !== '';
    }

    /**
     * Re-encrypt every APP_KEY-protected integration column with the current key. Run after rotating APP_KEY (with the
     * old key listed in APP_PREVIOUS_KEYS). A value that cannot be decrypted by any listed key is left untouched and counted.
     *
     * @return array<string, array{reencrypted: int, failed: int}>
     */
    public function reencryptAll(): array
    {
        $targets = [
            ['integration_app_credentials', 'client_secret'],
            ['webhook_endpoints', 'secret'], ['webhook_endpoints', 'previous_secret'],
            ['webhook_deliveries', 'payload'],
            ['oauth_states', 'verifier'],
            ['calendar_accounts', 'access_token'], ['calendar_accounts', 'refresh_token'],
        ];
        $report = [];
        foreach ($targets as [$table, $column]) {
            $report["{$table}.{$column}"] = $this->reencryptColumn($table, $column);
        }
        $this->rows = [];

        return $report;
    }

    /** @return array{reencrypted: int, failed: int} */
    private function reencryptColumn(string $table, string $column): array
    {
        $done = $failed = 0;
        DB::table($table)->whereNotNull($column)->orderBy('id')->chunkById(200, function ($rows) use ($table, $column, &$done, &$failed) {
            foreach ($rows as $row) {
                try {
                    $plain = Crypt::decryptString($row->{$column});
                    DB::table($table)->where('id', $row->id)->update([$column => Crypt::encryptString($plain)]);
                    $done++;
                } catch (Throwable) {
                    $failed++;
                }
            }
        });

        return ['reencrypted' => $done, 'failed' => $failed];
    }

    private function row(string $provider): ?AppCredential
    {
        if (! array_key_exists($provider, $this->rows)) {
            try {
                $this->rows[$provider] = AppCredential::where('provider_key', $provider)->where('enabled', true)->first() ?? false;
            } catch (QueryException) {
                // The table does not exist yet (code deployed a moment before the migration ran): use the environment values.
                return null;
            }
        }

        return $this->rows[$provider] ?: null;
    }

    private function complete(AppCredential $row): bool
    {
        return $row->client_id !== null && $row->client_id !== '' && $row->client_secret !== null && $row->client_secret !== '';
    }
}
