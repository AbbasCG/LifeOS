<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Models\UserSetting;
use App\Services\GoalReviewService;
use Illuminate\Console\Command;
use Throwable;

/**
 * Hourly: on the 1st of the month, prepare the opt-in monthly goal review for the month that just ended. A review is
 * a Copilot conversation; any next step it proposes waits for the user's approval.
 */
class PrepareGoalReviews extends Command
{
    protected $signature = 'lifeos:goal-reviews';

    protected $description = 'Prepare opt-in monthly goal reviews (proposals only)';

    public function handle(GoalReviewService $reviews): int
    {
        $prepared = 0;
        UserSetting::query()->select(['id', 'user_id'])->chunkById(200, function ($settings) use ($reviews, &$prepared) {
            foreach (User::whereIn('id', $settings->pluck('user_id'))->get() as $user) {
                if (! $reviews->due($user)) {
                    continue;
                }
                try {
                    $prepared += $reviews->prepareMonthly($user, ($user->preferences()['language'] ?? 'en') === 'ar' ? 'ar' : 'en') ? 1 : 0;
                } catch (Throwable $e) {
                    report($e);
                }
            }
        });
        $this->info("Prepared {$prepared} monthly goal review(s).");

        return self::SUCCESS;
    }
}
