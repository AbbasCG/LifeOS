<?php

namespace App\Console\Commands;

use App\Integrations\Vault\CredentialVault;
use Illuminate\Console\Command;

class ReencryptIntegrationSecrets extends Command
{
    protected $signature = 'lifeos:integrations:reencrypt';

    protected $description = 'Re-encrypt integration secrets and tokens with the current APP_KEY (run after rotating the key with the old one in APP_PREVIOUS_KEYS).';

    public function handle(CredentialVault $vault): int
    {
        $failed = 0;
        foreach ($vault->reencryptAll() as $column => $result) {
            $this->line(sprintf('%-45s re-encrypted: %d, could not decrypt: %d', $column, $result['reencrypted'], $result['failed']));
            $failed += $result['failed'];
        }
        if ($failed > 0) {
            $this->warn("{$failed} value(s) could not be decrypted with any configured key and were left unchanged. Keep the old key in APP_PREVIOUS_KEYS until they are re-entered.");

            return self::FAILURE;
        }
        $this->info('Done. After this, the old key can be removed from APP_PREVIOUS_KEYS once the other encrypted data (two-factor secrets, push keys) has been checked too.');

        return self::SUCCESS;
    }
}
