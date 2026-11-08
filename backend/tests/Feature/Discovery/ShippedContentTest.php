<?php

namespace Tests\Feature\Discovery;

use App\Models\UserSetting;
use App\Services\Discovery\DiscoveryRegistry;

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
