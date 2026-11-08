<?php

namespace Tests\Feature\Discovery;

use App\Models\InboxNotification;
use App\Models\ProductRelease;
use App\Models\UserSetting;
use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\ReleaseService;

/**
 * The release content that ships in resources/discovery, once an administrator has approved it and the deploy is confirmed: it must really
 * appear in What's New, in each language, with working "Try now" targets. Written for every release in the folder, so a new content file
 * is checked by the same test. (Approval and deployment themselves are simulated exactly as in the other Discovery tests.)
 */
class ShippedContentTest extends DiscoveryTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->app->singleton(DiscoveryRegistry::class, fn () => new DiscoveryRegistry(resource_path('discovery')));
        $this->app->forgetInstance(DiscoveryRegistry::class);
        $this->freshControllers();
    }

    /** @return list<string> */
    private function frontendPaths(): array
    {
        $routes = file_get_contents(base_path('../frontend/src/routes/AppRoutes.tsx')) ?: '';
        preg_match_all('/path="([^"]+)"/', $routes, $found);

        return array_map(fn (string $p) => '/'.ltrim($p, '/'), $found[1]);
    }

    private function memberIn(string $language)
    {
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['language' => $language]]);

        return $user;
    }

    public function test_every_shipped_release_appears_in_whats_new_in_all_three_languages(): void
    {
        $keys = array_keys(app(DiscoveryRegistry::class)->releases());
        $this->assertNotEmpty($keys, 'there is shipped content to check');
        foreach ($keys as $key) {
            $this->goLive($key);
        }

        $texts = [];
        foreach (['en', 'ar', 'nl'] as $language) {
            $this->actingAs($this->memberIn($language));
            $history = $this->getJson('/api/discovery/releases')->assertOk()->json('data');
            $this->assertCount(count($keys), $history, "the history lists every shipped release ({$language})");
            foreach ($history as $release) {
                $this->assertNotSame('', trim($release['title']));
                $this->assertNotSame('', trim($release['summary']));
                $this->assertNotEmpty($release['items']);
                $texts[$release['key']][$language][] = $release['title'].'|'.implode('|', array_map(fn ($i) => $i['title'].'|'.$i['body'], $release['items']));
            }
        }
        foreach ($texts as $key => $byLanguage) {
            $this->assertNotSame($byLanguage['en'], $byLanguage['ar'], "{$key}: the Arabic text is not the English one");
            $this->assertNotSame($byLanguage['en'], $byLanguage['nl'], "{$key}: the Dutch text is not the English one");
        }
    }

    public function test_the_newest_release_is_announced_once_to_a_person_and_try_now_works(): void
    {
        $registry = app(DiscoveryRegistry::class);
        foreach (array_keys($registry->releases()) as $key) {
            $this->goLive($key);
        }
        $newest = collect($registry->releases())->sortByDesc('date')->keys()->first();
        $this->actingAs($this->memberIn('en'));

        $announcement = $this->getJson('/api/discovery/bootstrap')->assertOk()->json('data.announcement');
        $this->assertSame($newest, $announcement['key']);
        foreach ($announcement['items'] as $item) {
            if ($item['feature']) {
                $this->assertTrue($item['can_try'], "{$item['feature']} can be tried by an ordinary account on the web");
                $this->postJson("/api/discovery/features/{$item['feature']}/try")->assertOk()->assertJsonPath('data.available', true);
            }
            $this->assertTrue($item['is_new'] || ! $item['feature'], 'a feature of a fresh release carries the New mark');
        }
        $guide = $this->getJson('/api/discovery/guide')->assertOk()->json('data');
        $this->assertNotNull($guide);
    }

    /** The point of it all: whatever content ships with the code reaches people by itself after a healthy deploy, with nothing for anybody to click. */
    public function test_after_a_healthy_deploy_everything_shipped_shows_up_by_itself(): void
    {
        config(['discovery.auto_approve' => true]);
        $registry = app(DiscoveryRegistry::class);
        $keys = array_keys($registry->releases());
        $this->deploy();
        $person = $this->memberIn('ar');
        $admin = $this->admin();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->app->forgetInstance(ReleaseService::class);
        $this->freshControllers();

        foreach ($keys as $key) {
            $row = ProductRelease::where('key', $key)->firstOrFail();
            $this->assertSame('approved', $row->review_status, "{$key} is approved by the deploy");
            $this->assertSame($registry->fingerprint($key), $row->approved_hash);
        }
        $this->actingAs($person);
        $bootstrap = $this->getJson('/api/discovery/bootstrap')->assertOk()->json('data');
        $this->assertNotNull($bootstrap['announcement'], 'something is announced on opening the site');
        $this->assertSame(count($keys), $bootstrap['counts']['unseen_updates'], 'every release is waiting, counted on the menu');
        $this->assertCount(count($keys), $this->getJson('/api/discovery/releases')->json('data'), 'the history lists them all');

        // What is for administrators only is not shown to anybody else, and is shown to an administrator.
        $itemsOf = fn () => collect($this->getJson('/api/discovery/releases')->json('data'))->flatMap(fn ($r) => $r['items'])->pluck('feature')->filter()->all();
        $this->assertNotContains('approve-updates', $itemsOf());
        $this->actingAs($admin);
        $this->assertContains('approve-updates', $itemsOf());

        // Reading clears the notification.
        $this->actingAs($person);
        $before = InboxNotification::where('user_id', $person->id)->where('kind', 'release')->count();
        $this->assertGreaterThan(0, $before);
        $this->getJson('/api/discovery/releases')->assertOk();   // the history page loads...
        foreach ($keys as $key) {
            $this->putJson("/api/discovery/states/release/{$key}", ['action' => 'seen'])->assertOk();   // ...and marks what it lists as seen
        }
        $this->assertSame(0, InboxNotification::where('user_id', $person->id)->where('kind', 'release')->count());
        $this->assertSame(0, $this->getJson('/api/discovery/bootstrap')->json('data.counts.unseen_updates'));
    }

    public function test_every_target_inside_the_shipped_content_exists_in_the_app(): void
    {
        $registry = app(DiscoveryRegistry::class);
        $paths = $this->frontendPaths();
        $check = function (string $where, string $route) use ($paths): void {
            $path = '/'.trim(strtok($route, '?') ?: '/', '/');
            $this->assertTrue($path === '/' || in_array($path, $paths, true), "{$where}: {$route} is not a screen of the app");
        };
        foreach ($registry->features() as $id => $feature) {
            $check("feature {$id}", $feature['route']);
            foreach ($feature['hints'] as $hint) {
                $check("hint {$hint['id']}", $hint['route']);
            }
        }
        foreach ($registry->releases() as $key => $release) {
            foreach ($release['items'] as $i => $item) {
                if (isset($item['link'])) {
                    $check("release {$key} item {$i}", $item['link']);
                }
            }
        }
        foreach ($registry->tours() as $id => $tour) {
            foreach ($tour['steps'] as $i => $step) {
                if ($step['route']) {
                    $check("tour {$id} step {$i}", $step['route']);
                }
            }
        }
    }

    public function test_every_tour_of_the_shipped_content_can_be_opened_and_its_targets_exist_in_the_screens(): void
    {
        $registry = app(DiscoveryRegistry::class);
        foreach (array_keys($registry->releases()) as $key) {
            $this->goLive($key);
        }
        $source = '';
        foreach (['components/layout', 'features', 'components'] as $dir) {
            foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(base_path('../frontend/src/'.$dir), \FilesystemIterator::SKIP_DOTS)) as $file) {
                if (preg_match('/\.tsx$/', $file->getFilename())) {
                    $source .= file_get_contents($file->getPathname());
                }
            }
        }
        $this->actingAs($this->memberIn('ar'));
        foreach ($registry->tours() as $id => $tour) {
            $this->getJson("/api/discovery/tours/{$id}")->assertOk()->assertJsonCount(count($tour['steps']), 'data.steps');
            foreach ($tour['steps'] as $step) {
                $target = $step['target'];
                // A target exists as data-tour/data-hint="id" or, for the menu, as data-tour={`nav-...`} built from the item's path.
                $present = str_contains($source, 'data-tour="'.$target.'"') || str_contains($source, 'data-hint="'.$target.'"')
                    || (str_starts_with($target, 'nav-') && str_contains($source, "data-tour={to === '/' ? 'nav-today'"));
                $this->assertTrue($present, "tour {$id}: no screen carries the target \"{$target}\"");
            }
        }
    }
}
