<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('lifeos:reminders')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('lifeos:sync-calendars')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:automations')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('lifeos:recommendations')->hourly()->withoutOverlapping();
