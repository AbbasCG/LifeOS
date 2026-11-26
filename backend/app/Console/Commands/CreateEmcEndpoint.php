<?php

namespace App\Console\Commands;

use App\Integrations\Emc\EmcWebhookHandler;
use App\Integrations\Webhooks\WebhookEndpointService;
use App\Models\User;
use App\Models\WebhookEndpoint;
use Illuminate\Console\Command;
use Illuminate\Database\UniqueConstraintViolationException;

class CreateEmcEndpoint extends Command
{
    protected $signature = 'lifeos:emc:create-endpoint
        {email : the LifeOS account the EMC tickets belong to}
        {--account=default : key of the EMC account (lowercase letters, digits, "-" and "_"; at most 64)}
        {--name= : label shown to administrators}
        {--force : skip the confirmation in production}';

    protected $description = 'Create the signed webhook endpoint that EMC sends one LifeOS user\'s ticket events to (require_event_id on). Prints the secret once.';

    public function handle(WebhookEndpointService $endpoints): int
    {
        $account = (string) $this->option('account');
        if (! preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/D', $account)) {
            $this->error('--account must be 1-64 characters: lowercase letters, digits, "-" and "_", starting with a letter or digit.');

            return self::INVALID;
        }
        $user = User::where('email', mb_strtolower(trim((string) $this->argument('email'))))->first();
        if (! $user) {
            $this->error('No LifeOS account has that email address.');

            return self::FAILURE;
        }
        $existing = WebhookEndpoint::where('provider_key', EmcWebhookHandler::PROVIDER)->where('user_id', $user->id)->where('account_key', $account)->first();
        if ($existing) {
            $this->error("This account already has an EMC endpoint for \"{$account}\" (public id {$existing->public_id}, ".($existing->enabled ? 'enabled' : 'disabled').'). Rotate its secret instead of creating another.');

            return self::FAILURE;
        }
        if (app()->isProduction() && ! $this->option('force') && ! $this->confirm("Create a LIVE EMC endpoint for {$user->email} (account \"{$account}\")? EMC can then create tasks for this person.")) {
            $this->warn('Nothing was created.');

            return self::FAILURE;
        }
        $name = (string) ($this->option('name') ?: "EMC ({$account})");
        try {
            ['endpoint' => $endpoint, 'secret' => $secret] = $endpoints->create(EmcWebhookHandler::PROVIDER, $user, $name, requireEventId: true, accountKey: $account);
        } catch (UniqueConstraintViolationException) {
            $this->error('Another process created this endpoint at the same time; nothing more was created.');

            return self::FAILURE;
        }
        $this->info("EMC endpoint created for {$user->email}, account \"{$account}\" (signed event_id required).");
        $this->line('URL:    '.rtrim((string) config('app.url'), '/').'/api/webhooks/'.$endpoint->public_id);
        $this->line('Secret: '.$secret);
        $this->warn('The secret is shown only this once. Give it to EMC through a secure channel; it is stored encrypted and cannot be read back.');

        return self::SUCCESS;
    }
}
