<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('lifeos:reminders')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('lifeos:sync-calendars')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:sync-outbound')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:automations')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:recommendations')->hourly()->withoutOverlapping();
Schedule::command('lifeos:weekly-drafts')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:goal-reviews')->hourly()->withoutOverlapping();
// Re-queues webhook deliveries whose job was lost (queue outage, worker stopped before running it); never failed ones. The processing generation
// makes a late copy of the lost job do nothing, so a delivery is still applied once.
Schedule::command('lifeos:webhooks:retry --stuck')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:integrations:prune')->dailyAt('03:20')->withoutOverlapping();
// Registers releases only after a healthy deploy is confirmed; does nothing while DISCOVERY_AUTO_ACTIVATE is off.
Schedule::command('lifeos:discovery:reconcile')->everyFiveMinutes()->withoutOverlapping();
