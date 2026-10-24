<?php

namespace App\Console\Commands;

use App\Demo\DemoMode;
use Database\Seeders\LifeOSDemoSeeder;
use Illuminate\Console\Command;
use Throwable;

class DemoData extends Command
{
    protected $signature = 'lifeos:demo
        {--lang=en : Language of the demo content and interface (en or ar)}
        {--password= : Set the demo account password (otherwise kept, or generated for a new account)}
        {--reset : Only remove the demo account\'s records (keeps the account)}
        {--remove : Remove the demo account and all of its records}';

    protected $description = 'Seed, reset or remove the local LifeOS demo account. Local/testing only, requires LIFEOS_DEMO_ENABLED=true.';

    public function handle(): int
    {
        if (! DemoMode::allowed()) {
            $this->error('Demo data is disabled here. It only runs with APP_ENV=local (or testing) and LIFEOS_DEMO_ENABLED=true, and never in production.');

            return self::FAILURE;
        }
        try {
            if ($this->option('reset') || $this->option('remove')) {
                $user = DemoMode::user();
                if (! $user) {
                    $this->info('No demo account found. Nothing to do.');

                    return self::SUCCESS;
                }
                $deleted = DemoMode::reset($user, (bool) $this->option('remove'));
                $this->info(($this->option('remove') ? 'Removed the demo account' : 'Reset the demo account').' ('.array_sum($deleted).' rows). Other accounts were not touched.');

                return self::SUCCESS;
            }
            $language = (string) $this->option('lang');
            if (! in_array($language, ['en', 'ar'], true)) {
                $this->error('--lang must be en or ar.');

                return self::FAILURE;
            }
            $seeder = new LifeOSDemoSeeder;
            $seeder->language = $language;
            $seeder->password = $this->option('password') ?: (config('demo.password') ?: null);
            $seeder->setContainer($this->laravel)->setCommand($this);
            $seeder->__invoke();
        } catch (Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $this->newLine();
        $this->info('Demo account ready.');
        $this->line('  Email:    '.config('demo.email'));
        $this->line('  Password: '.($seeder->generatedPassword ?? ($seeder->password ? '(the password you provided)' : '(unchanged — use the existing demo password, or re-run with --password=...)')));
        if ($seeder->generatedPassword) {
            $this->warn('  This generated password is shown only once. Re-run with --password=... to choose your own.');
        }

        return self::SUCCESS;
    }
}
