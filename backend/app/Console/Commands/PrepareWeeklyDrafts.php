<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Models\UserSetting;
use App\Services\WeeklyDraftService;
use Illuminate\Console\Command;
use Throwable;

/**
 * Every 15 minutes: prepare next week's plan draft for users who switched weekly drafts on and whose chosen weekday
 * and time have come. A draft is only a Copilot conversation with a pending proposal; nothing is written to tasks or
 * calendars.
 */
class PrepareWeeklyDrafts extends Command
{
    protected $signature = 'lifeos:weekly-drafts';

    protected $description = 'Prepare opt-in weekly plan drafts (pending proposals only)';

    public function handle(WeeklyDraftService $drafts): int
    {
        $prepared = 0;
        UserSetting::query()->select(['id', 'user_id'])->chunkById(200, function ($settings) use ($drafts, &$prepared) {
            foreach (User::whereIn('id', $settings->pluck('user_id'))->get() as $user) {
                if (! $drafts->due($user)) {
                    continue;
                }
                try {
                    $drafts->prepare($user, ($user->preferences()['language'] ?? 'en') === 'ar' ? 'ar' : 'en', true);
                    $prepared++;
                } catch (Throwable $e) {
                    report($e);
                }
            }
        });
        $this->info("Prepared {$prepared} weekly draft(s).");

        return self::SUCCESS;
    }
}
