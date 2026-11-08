<?php

namespace App\Services\Discovery;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Push\WebPush;
use App\Models\User;
use App\Services\AssistantService;

/**
 * Decides, on the server and for one person, whether a feature can be used right now. A feature lists what it needs
 * ("requires"); every entry is one of the names below, and a name this class does not know is never satisfied, so a typo
 * hides a feature instead of showing a button that cannot work.
 *
 *   admin                      the person is a LifeOS administrator (such features are hidden from everyone else)
 *   ai_enabled                 an external AI provider is configured and the person has not switched it off
 *   voice_allowed              the account allows dictation
 *   push_configured            this installation can send browser push notifications
 *   integration_ready:<id>     the connector's OAuth client has credentials (the person can connect it)
 *   config:<name>              a boolean setting named in config/discovery.php "flags" is on (an existing environment flag)
 */
class FeatureGate
{
    public function __construct(private AssistantService $assistant, private WebPush $push, private CalendarProviders $providers) {}

    /** Whether the registry may accept this requirement (the name and its argument are well-formed). */
    public static function isValid(string $requirement): bool
    {
        [$name, $argument] = array_pad(explode(':', $requirement, 2), 2, null);

        return match ($name) {
            'admin', 'ai_enabled', 'voice_allowed', 'push_configured' => $argument === null,
            'integration_ready' => is_string($argument) && preg_match('/^[a-z][a-z0-9_]{1,39}$/', $argument) === 1,
            'config' => is_string($argument) && preg_match('/^[a-z][a-z0-9_]{1,39}$/', $argument) === 1,
            default => false,
        };
    }

    /**
     * @param  list<string>  $requires
     * @return array{available: bool, reason: ?string} reason is the first unmet requirement: admin_only, ai_off, voice_off, push_off, setup_needed, disabled or unknown
     */
    public function check(User $user, array $requires): array
    {
        foreach ($requires as $requirement) {
            $reason = $this->unmet($user, $requirement);
            if ($reason !== null) {
                return ['available' => false, 'reason' => $reason];
            }
        }

        return ['available' => true, 'reason' => null];
    }

    private function unmet(User $user, string $requirement): ?string
    {
        if (! self::isValid($requirement)) {
            return 'unknown';
        }
        [$name, $argument] = array_pad(explode(':', $requirement, 2), 2, null);

        return match ($name) {
            'admin' => $user->is_admin ? null : 'admin_only',
            'ai_enabled' => $this->assistant->provider($user) !== null ? null : 'ai_off',
            'voice_allowed' => ($user->preferences()['voice_input'] ?? true) ? null : 'voice_off',
            'push_configured' => $this->push->isConfigured() ? null : 'push_off',
            'integration_ready' => $this->providers->get((string) $argument)?->isConfigured() === true ? null : 'setup_needed',
            'config' => ($key = config('discovery.flags')[$argument] ?? null) !== null && (bool) config($key) ? null : 'disabled',
            default => 'unknown',
        };
    }
}
