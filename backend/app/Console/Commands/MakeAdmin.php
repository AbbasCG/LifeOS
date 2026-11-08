<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Console\Command;

class MakeAdmin extends Command
{
    protected $signature = 'lifeos:make-admin {email : Email of an existing account} {--revoke : Remove administrator rights instead}';

    protected $description = 'Grant (or with --revoke, remove) LifeOS administrator rights, which allow managing integration credentials.';

    public function handle(AuditLogger $audit): int
    {
        $user = User::where('email', mb_strtolower((string) $this->argument('email')))->first();
        if (! $user) {
            $this->error('No account with that email address.');

            return self::FAILURE;
        }
        $grant = ! $this->option('revoke');
        if ($user->is_admin === $grant) {
            $this->info($grant ? 'Already an administrator.' : 'Not an administrator.');

            return self::SUCCESS;
        }
        $user->forceFill(['is_admin' => $grant])->save();
        $audit->log($user, $grant ? 'admin_granted' : 'admin_revoked', null, ['via' => 'artisan']);
        $this->info($grant ? "{$user->email} is now a LifeOS administrator. Two-factor authentication is required before credentials can be changed." : "{$user->email} is no longer an administrator.");

        return self::SUCCESS;
    }
}
