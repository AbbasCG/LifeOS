<?php

namespace Tests\Feature\Discovery;

use App\Models\ProductRelease;
use App\Models\User;
use App\Services\Discovery\DeployConfirmation;
use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\ReleaseService;
use App\Services\TwoFactorService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Shared set-up: content files are written to a temporary directory (never the real resources/discovery), and the deploy
 * confirmation is a stand-in that says what the test needs.
 */
abstract class DiscoveryTestCase extends TestCase
{
    use RefreshDatabase;

    protected string $content;

    protected function setUp(): void
    {
        parent::setUp();
        // The activation switch is on for these tests (its default, off, has tests of its own).
        config(['discovery.auto_activate' => true]);
        $this->content = sys_get_temp_dir().'/lifeos-discovery-'.bin2hex(random_bytes(6));
        foreach (['releases', 'features', 'tours'] as $dir) {
            mkdir($this->content.'/'.$dir, 0777, true);
        }
        $this->app->singleton(DiscoveryRegistry::class, fn () => new DiscoveryRegistry($this->content));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->content.'/*/*') ?: [] as $file) {
            @unlink($file);
        }
        foreach (glob($this->content.'/*') ?: [] as $dir) {
            @rmdir($dir);
        }
        @rmdir($this->content);
        parent::tearDown();
    }

    // ---- content ----

    /** @return array<string, string> */
    protected function t(string $text): array
    {
        return ['ar' => "ar {$text}", 'nl' => "nl {$text}", 'en' => "en {$text}"];
    }

    /** @param  array<string, mixed>  $overrides */
    protected function release(string $key = 'r-one', array $overrides = []): array
    {
        return array_merge(['key' => $key, 'date' => '2026-11-08', 'revision' => 1, 'importance' => 'important', 'audiences' => ['web', 'mobile'],
            'title' => $this->t('Title'), 'summary' => $this->t('Summary'), 'items' => [['type' => 'new', 'feature' => 'quick-capture']]], $overrides);
    }

    /** @param  array<string, mixed>  $overrides */
    protected function feature(string $id = 'quick-capture', array $overrides = []): array
    {
        return array_merge(['id' => $id, 'category' => 'tasks', 'name' => $this->t('Quick capture'), 'description' => $this->t('Type a phrase'), 'route' => '/tasks',
            'since' => 'r-one', 'client_version' => 1, 'new_days' => 14, 'requires' => []], $overrides);
    }

    /** @param  array<string, mixed>  $overrides */
    protected function tour(string $id = 'quick-tour', array $overrides = []): array
    {
        return array_merge(['id' => $id, 'version' => 1, 'title' => $this->t('Tour'), 'steps' => [['target' => 'quick-add', 'title' => $this->t('Step'), 'body' => $this->t('Body')]]], $overrides);
    }

    protected function write(string $kind, array $data): void
    {
        $name = $data['key'] ?? $data['id'];
        file_put_contents("{$this->content}/{$kind}/{$name}.json", json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        $this->app->forgetInstance(DiscoveryRegistry::class);
        $this->freshControllers();
    }

    /** A route keeps its controller object between requests of one test, so a changed registry would not reach it. */
    protected function freshControllers(): void
    {
        foreach ($this->app['router']->getRoutes()->getRoutes() as $route) {
            $route->flushController();
        }
    }

    /** Writes the usual pair: one release with one feature. */
    protected function publishable(array $release = [], array $feature = []): void
    {
        $this->write('releases', $this->release('r-one', $release));
        $this->write('features', $this->feature('quick-capture', $feature));
    }

    // ---- deploy confirmation ----

    /** Pretends the running code is the last healthy deploy (or, with a status, whatever state is being tested). */
    protected function deploy(string $status = 'confirmed', string $sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'): void
    {
        $this->app->instance(DeployConfirmation::class, new class($status, $sha) extends DeployConfirmation
        {
            public function __construct(private string $fakeStatus, private string $fakeSha)
            {
                parent::__construct();
            }

            public function inspect(): array
            {
                return ['enabled' => $this->fakeStatus !== 'disabled', 'status' => $this->fakeStatus, 'marker_path' => '/fake', 'marker' => $this->fakeSha, 'head' => $this->fakeSha, 'detail' => 'fake'];
            }
        });
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
    }

    /** Registers the release in the database (as a healthy deploy would) and approves the text now in the code. */
    protected function goLive(string $key = 'r-one'): void
    {
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $hash = $this->hash($key);
        ProductRelease::where('key', $key)->update(['review_status' => 'approved', 'approved_hash' => $hash, 'content_hash' => $hash, 'reviewed_at' => now(), 'published_at' => now()]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
    }

    /** The administrator approves the text now in the code again (after a test changed it). */
    protected function reapprove(string $key = 'r-one'): void
    {
        $hash = $this->hash($key);
        ProductRelease::where('key', $key)->update(['review_status' => 'approved', 'approved_hash' => $hash, 'content_hash' => $hash]);
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();
    }

    /** The fingerprint an administrator would read from the list before approving. */
    protected function hash(string $key = 'r-one'): string
    {
        return (string) app(DiscoveryRegistry::class)->fingerprint($key);
    }

    // ---- people ----

    protected function admin(bool $twoFactor = true): User
    {
        $user = User::factory()->create();
        $user->forceFill(['is_admin' => true])->save();
        if ($twoFactor) {
            $user->forceFill(['two_factor_secret' => app(TwoFactorService::class)->generateSecret(), 'two_factor_confirmed_at' => now()])->save();
        }

        return $user;
    }

    /** A person who joined before the release went live, so the announcement is theirs to see. */
    protected function member(array $attributes = []): User
    {
        return User::factory()->create(['created_at' => now()->subDays(30)] + $attributes);
    }
}
