<?php

namespace App\Console\Commands;

use App\Integrations\Push\WebPush;
use Illuminate\Console\Command;

class GenerateVapidKeys extends Command
{
    protected $signature = 'lifeos:vapid-keys';

    protected $description = 'Generate a VAPID key pair for browser push. Prints the values; it never writes .env.';

    public function handle(): int
    {
        $keys = WebPush::generateKeys();
        $this->line('Add these to your server environment (keep the private key secret):');
        $this->line('VAPID_PUBLIC_KEY='.$keys['public_key']);
        $this->line('VAPID_PRIVATE_KEY='.$keys['private_key']);
        $this->line('VAPID_SUBJECT=mailto:you@example.com');

        return self::SUCCESS;
    }
}
