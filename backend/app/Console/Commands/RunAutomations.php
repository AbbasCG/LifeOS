<?php

namespace App\Console\Commands;

use App\Services\AutomationEngine;
use Illuminate\Console\Command;

class RunAutomations extends Command
{
    protected $signature = 'lifeos:automations';

    protected $description = 'Evaluate enabled automation rules with scheduled triggers (overdue tasks, recurring tasks, overloaded days).';

    public function handle(AutomationEngine $engine): int
    {
        $engine->runScheduled();

        return self::SUCCESS;
    }
}
