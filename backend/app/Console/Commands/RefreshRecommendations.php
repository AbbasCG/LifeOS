<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Services\IntelligenceSettings;
use App\Services\RecommendationService;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;

/**
 * Hourly: delete recommendation history past each user's retention period, and — only for users who chose the "daily"
 * frequency — refresh suggestions in their local morning so the single daily digest can be sent. Never changes work data.
 */
class RefreshRecommendations extends Command
{
    protected $signature = 'lifeos:recommendations';

    protected $description = 'Prune recommendation history and send the opt-in daily suggestion digest';

    public function handle(RecommendationService $recommendations): int
    {
        User::query()->select('id')->chunkById(200, function ($users) use ($recommendations) {
            foreach (User::whereIn('id', $users->pluck('id'))->get() as $user) {
                $recommendations->prune($user);
                $settings = IntelligenceSettings::for($user);
                if ($settings['frequency'] === 'daily' && $recommendations->enabled($user) && CarbonImmutable::now($user->timezone())->hour === 8) {
                    $recommendations->refresh($user);
                }
            }
        });

        return self::SUCCESS;
    }
}
