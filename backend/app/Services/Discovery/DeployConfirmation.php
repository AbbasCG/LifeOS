<?php

namespace App\Services\Discovery;

use Symfony\Component\Process\Process;

/**
 * Knows whether the code now running was released by a deploy that passed its health checks.
 *
 * scripts/deploy-production.sh writes the deployed commit to current.sha only after the health checks succeeded (a failed
 * or unhealthy deploy leaves the previous value). The marker therefore proves "a deploy of this commit finished and was
 * healthy" only while the checkout still IS that commit: the script moves the checkout early in a deploy, so a
 * checkout that differs from the marker means a deploy is in progress or failed. Both must match, and the feature is
 * switched off by default (config discovery.auto_activate) until the owner has checked the marker can be read.
 * Nothing here writes, and the production server is only ever read.
 */
class DeployConfirmation
{
    public function __construct(private ?string $markerPath = null, private ?string $repositoryPath = null) {}

    /**
     * @return array{enabled: bool, status: string, marker_path: string, marker: ?string, head: ?string, detail: string}
     *                                                                                                                   status: disabled, confirmed, not_confirmed, marker_missing, marker_unreadable, marker_invalid or head_unknown
     */
    public function inspect(): array
    {
        $enabled = (bool) config('discovery.auto_activate');
        $path = $this->markerPath ?? (string) config('discovery.deploy_marker');
        $report = fn (string $status, string $detail, ?string $marker = null, ?string $head = null): array => ['enabled' => $enabled, 'status' => $status, 'marker_path' => $path, 'marker' => $marker, 'head' => $head, 'detail' => $detail];

        if (! is_file($path)) {
            return $report('marker_missing', 'The deploy marker file does not exist (or this account cannot see its directory).');
        }
        if (! is_readable($path)) {
            return $report('marker_unreadable', 'The deploy marker exists but this account cannot read it.');
        }
        $marker = strtolower(trim((string) @file_get_contents($path)));
        if (! preg_match('/^[0-9a-f]{40}$/', $marker)) {
            return $report('marker_invalid', 'The deploy marker does not hold a 40-character commit.');
        }
        $head = $this->head();
        if ($head === null) {
            return $report('head_unknown', 'The running checkout\'s commit could not be read (git missing, or the checkout is owned by another account).', $marker);
        }
        if ($head !== $marker) {
            return $report('not_confirmed', 'The checkout is at a different commit than the last healthy deploy: a deploy is in progress or did not finish.', $marker, $head);
        }

        return $report($enabled ? 'confirmed' : 'disabled', $enabled ? 'The running commit is the last healthy deploy.' : 'The marker is readable and matches, but activation is switched off (DISCOVERY_AUTO_ACTIVATE).', $marker, $head);
    }

    /** The commit that is confirmed live, or null for any other state (including "switched off"). */
    public function confirmedSha(): ?string
    {
        $state = $this->inspect();

        return $state['status'] === 'confirmed' ? $state['marker'] : null;
    }

    private function head(): ?string
    {
        $repository = $this->repositoryPath ?? config('discovery.repository_path') ?: base_path('..');
        $process = new Process(['git', '-C', $repository, 'rev-parse', 'HEAD'], null, ['GIT_TERMINAL_PROMPT' => '0'], null, 5);
        try {
            $process->run();
        } catch (\Throwable) {
            return null;
        }
        $head = strtolower(trim($process->getOutput()));

        return $process->isSuccessful() && preg_match('/^[0-9a-f]{40}$/', $head) ? $head : null;
    }
}
