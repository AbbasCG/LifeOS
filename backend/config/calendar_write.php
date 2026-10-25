<?php

return [
    /*
     * Opt-in write-back to Google Calendar and Outlook. Off unless an administrator enables it. Even when on, nothing is
     * written until a user grants the separate write permission, picks a calendar, previews a change and confirms it.
     * LifeOS only ever changes or removes events it added itself.
     */
    'enabled' => (bool) env('LIFEOS_CALENDAR_WRITE', false),
    // How long a previewed change can be confirmed.
    'preview_minutes' => 10,
];
