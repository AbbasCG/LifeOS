<?php

namespace Tests\Feature\Discovery;

use App\Services\Discovery\DeployConfirmation;

/** The real marker and checkout logic, against a throw-away git repository and marker file. */
class DeployConfirmationTest extends DiscoveryTestCase
{
    private string $repo;

    private string $marker;

    protected function setUp(): void
    {
        parent::setUp();
        $this->repo = sys_get_temp_dir().'/lifeos-repo-'.bin2hex(random_bytes(5));
        mkdir($this->repo);
        $this->marker = $this->repo.'.sha';
        $git = fn (string $args) => shell_exec('cd '.escapeshellarg($this->repo).' && git -c user.email=t@t -c user.name=t '.$args.' 2>&1');
        $git('init -q');
        file_put_contents($this->repo.'/f', '1');
        $git('add f');
        $git('commit -q -m one');
    }

    protected function tearDown(): void
    {
        shell_exec('rm -rf '.escapeshellarg($this->repo));
        @unlink($this->marker);
        parent::tearDown();
    }

    private function sha(): string
    {
        return trim((string) shell_exec('cd '.escapeshellarg($this->repo).' && git rev-parse HEAD'));
    }

    private function inspect(): array
    {
        return (new DeployConfirmation($this->marker, $this->repo))->inspect();
    }

    public function test_it_is_off_by_default_even_when_everything_matches(): void
    {
        file_put_contents($this->marker, $this->sha()."\n");
        config(['discovery.auto_activate' => false]);
        $this->assertSame('disabled', $this->inspect()['status']);
        $this->assertNull((new DeployConfirmation($this->marker, $this->repo))->confirmedSha());
    }

    public function test_a_marker_that_matches_the_running_commit_confirms_the_deploy(): void
    {
        config(['discovery.auto_activate' => true]);
        file_put_contents($this->marker, $this->sha()."\n");
        $state = $this->inspect();
        $this->assertSame('confirmed', $state['status']);
        $this->assertSame($this->sha(), (new DeployConfirmation($this->marker, $this->repo))->confirmedSha());
    }

    public function test_a_checkout_that_moved_past_the_marker_is_not_confirmed(): void
    {
        config(['discovery.auto_activate' => true]);
        file_put_contents($this->marker, $this->sha()."\n");
        shell_exec('cd '.escapeshellarg($this->repo).' && echo 2 > f && git add f && git -c user.email=t@t -c user.name=t commit -q -m two');
        $state = $this->inspect();
        $this->assertSame('not_confirmed', $state['status'], 'a deploy that moved the code but did not finish healthy must not activate anything');
        $this->assertNull((new DeployConfirmation($this->marker, $this->repo))->confirmedSha());
    }

    public function test_a_missing_marker_is_reported_and_confirms_nothing(): void
    {
        config(['discovery.auto_activate' => true]);
        $this->assertSame('marker_missing', $this->inspect()['status']);
    }

    public function test_a_marker_that_is_not_a_commit_is_invalid(): void
    {
        config(['discovery.auto_activate' => true]);
        foreach (['not-a-sha', '', str_repeat('g', 40), substr($this->sha(), 0, 12)] as $content) {
            file_put_contents($this->marker, $content);
            $this->assertSame('marker_invalid', $this->inspect()['status'], "content: {$content}");
        }
    }

    public function test_a_checkout_that_is_not_a_git_repository_cannot_be_compared(): void
    {
        config(['discovery.auto_activate' => true]);
        file_put_contents($this->marker, $this->sha());
        $state = (new DeployConfirmation($this->marker, sys_get_temp_dir()))->inspect();
        $this->assertSame('head_unknown', $state['status']);
    }

    public function test_an_unreadable_marker_is_reported(): void
    {
        if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
            $this->markTestSkipped('root can read any file, so unreadable cannot be simulated here');
        }
        config(['discovery.auto_activate' => true]);
        file_put_contents($this->marker, $this->sha());
        chmod($this->marker, 0000);
        $this->assertSame('marker_unreadable', $this->inspect()['status']);
    }
}
