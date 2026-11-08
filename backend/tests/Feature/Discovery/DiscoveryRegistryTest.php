<?php

namespace Tests\Feature\Discovery;

use App\Services\Discovery\DiscoveryRegistry;
use App\Services\Discovery\InvalidDiscoveryContentException;
use PHPUnit\Framework\Attributes\DataProvider;

class DiscoveryRegistryTest extends DiscoveryTestCase
{
    private function load(): DiscoveryRegistry
    {
        return new DiscoveryRegistry($this->content);
    }

    public function test_an_empty_directory_has_no_content(): void
    {
        $registry = $this->load();
        $this->assertSame([], $registry->releases());
        $this->assertSame([], $registry->features());
        $this->assertSame([], $registry->tours());
    }

    public function test_the_shipped_content_directory_is_valid_and_every_release_has_a_fingerprint(): void
    {
        // Content may ship with the code; it is shown to nobody until an administrator approves exactly this text (see AnnouncementTest and ShippedContentTest).
        $registry = new DiscoveryRegistry(resource_path('discovery'));
        foreach ($registry->releases() as $key => $release) {
            $this->assertNotNull($registry->fingerprint($key), "the release {$key} needs a fingerprint an administrator can approve");
            $this->assertNotEmpty($release['items']);
        }
    }

    public function test_valid_content_loads_and_links_features_and_tours(): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->write('features', $this->feature('quick-capture', ['tour' => 'quick-tour', 'client_version' => 3, 'hints' => [['id' => 'qc-hint', 'target' => 'quick-add', 'route' => '/tasks', 'text' => $this->t('Try it')]]]));
        $this->write('releases', $this->release('r-one'));
        $registry = $this->load();
        $this->assertSame(3, $registry->release('r-one')['min_client'], 'a release needs the newest client of any feature it mentions');
        $this->assertSame('quick-capture', $registry->hintFeature('qc-hint'));
        $this->assertSame('quick-tour', $registry->feature('quick-capture')['tour']);
    }

    public function test_releases_are_ordered_newest_first(): void
    {
        $this->write('features', $this->feature('quick-capture', ['since' => 'r-old']));
        $this->write('releases', $this->release('r-old', ['date' => '2026-10-01']));
        $this->write('releases', $this->release('r-new', ['date' => '2026-11-08']));
        $this->assertSame(['r-new', 'r-old'], array_keys($this->load()->releases()));
    }

    /** @return array<string, array{0: string, 1: callable, 2: string}> */
    public static function invalid(): array
    {
        return [
            'missing language' => ['releases', fn ($r) => ['title' => ['ar' => 'a', 'en' => 'e']] + $r, 'ar, nl and en'],
            'extra language' => ['releases', fn ($r) => ['title' => ['ar' => 'a', 'nl' => 'n', 'en' => 'e', 'fr' => 'f']] + $r, 'ar, nl and en'],
            'empty text' => ['releases', fn ($r) => ['summary' => ['ar' => '', 'nl' => 'n', 'en' => 'e']] + $r, 'non-empty'],
            'unknown field' => ['releases', fn ($r) => $r + ['status' => 'published'], 'unknown field'],
            'draft key left in a release' => ['releases', fn ($r) => $r + ['_draft' => 'Delete this key'], 'unknown field'],
            'draft marker as a whole text' => ['releases', fn ($r) => ['title' => ['ar' => '⟦DRAFT⟧', 'nl' => 'n', 'en' => 'e']] + $r, 'draft marker'],
            'draft marker inside a longer text' => ['releases', fn ($r) => ['summary' => ['ar' => 'a', 'nl' => 'n', 'en' => '⟦DRAFT⟧ One or two sentences']] + $r, 'draft marker'],
            'draft marker in an item' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => ['ar' => 'a', 'nl' => 'n', 'en' => 'Title'], 'body' => ['ar' => 'a', 'nl' => '⟦DRAFT⟧', 'en' => 'Body']]]] + $r, 'draft marker'],
            'draft marker in a feature' => ['features', fn ($f) => ['description' => ['ar' => 'a', 'nl' => 'n', 'en' => 'x ⟦DRAFT⟧']] + $f, 'draft marker'],
            'draft marker in a tour step' => ['tours', fn ($t) => ['steps' => [['target' => 'quick-add', 'title' => ['ar' => '⟦DRAFT⟧', 'nl' => 'n', 'en' => 'e'], 'body' => self::tt()]]] + $t, 'draft marker'],
            'bad item type' => ['releases', fn ($r) => ['items' => [['type' => 'fixed2', 'feature' => 'quick-capture']]] + $r, 'type'],
            'no items' => ['releases', fn ($r) => ['items' => []] + $r, 'non-empty list'],
            'item without text or feature' => ['releases', fn ($r) => ['items' => [['type' => 'new']]] + $r, 'required when no feature'],
            'unknown feature' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'feature' => 'nope']]] + $r, 'does not exist'],
            'external link' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'link' => 'https://evil.example/x']]] + $r, 'inside LifeOS'],
            'protocol-relative link' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'link' => '//evil.example']]] + $r, 'inside LifeOS'],
            'javascript link' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'link' => 'javascript:alert(1)']]] + $r, 'inside LifeOS'],
            'image outside discovery' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'image' => ['src' => 'https://cdn.example/a.png', 'alt' => self::tt()]]]] + $r, 'under /discovery/'],
            'image without alt text' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'image' => ['src' => '/discovery/r-one/a.png']]]] + $r, 'ar, nl and en'],
            'image path traversal' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'image' => ['src' => '/discovery/../secret.png', 'alt' => self::tt()]]]] + $r, 'under /discovery/'],
            'video with an image extension' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'video' => ['src' => '/discovery/r-one/a.png', 'poster' => '/discovery/r-one/p.png', 'label' => self::tt()]]]] + $r, 'mp4, webm'],
            'video without a poster' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'video' => ['src' => '/discovery/r-one/a.mp4', 'label' => self::tt()]]]] + $r, 'poster'],
            'bad date' => ['releases', fn ($r) => ['date' => '08/11/2026'] + $r, 'YYYY-MM-DD'],
            'impossible calendar date' => ['releases', fn ($r) => ['date' => '2026-02-31'] + $r, 'YYYY-MM-DD'],
            'link ending in a newline' => ['releases', fn ($r) => ['items' => [['type' => 'new', 'title' => self::tt(), 'body' => self::tt(), 'link' => "/tasks\n"]]] + $r, 'inside LifeOS'],
            'bad importance' => ['releases', fn ($r) => ['importance' => 'urgent'] + $r, 'importance'],
            'empty audiences' => ['releases', fn ($r) => ['audiences' => []] + $r, 'audiences'],
            'unknown audience' => ['releases', fn ($r) => ['audiences' => ['desktop']] + $r, 'audiences'],
            'key not matching file' => ['releases', fn ($r) => ['key' => 'other-key'] + $r, 'file name'],
            'bad key' => ['releases', fn ($r) => ['key' => 'Bad_Key'] + $r, 'lower-case'],
            'unknown requirement' => ['features', fn ($f) => ['requires' => ['wizard']] + $f, 'unknown requirement'],
            'requirement without its argument' => ['features', fn ($f) => ['requires' => ['integration_ready']] + $f, 'unknown requirement'],
            'feature route outside the app' => ['features', fn ($f) => ['route' => 'https://x.example'] + $f, 'inside LifeOS'],
            'feature of an unknown release' => ['features', fn ($f) => ['since' => 'no-such-release'] + $f, 'does not exist'],
            'feature with an unknown tour' => ['features', fn ($f) => ['tour' => 'no-tour'] + $f, 'does not exist'],
            'feature with a bad category' => ['features', fn ($f) => ['category' => 'misc'] + $f, 'category'],
            'new_days out of range' => ['features', fn ($f) => ['new_days' => 400] + $f, 'new_days'],
            'client_version zero' => ['features', fn ($f) => ['client_version' => 0] + $f, 'client_version'],
            'tour step that clicks' => ['tours', fn ($t) => ['steps' => [['target' => 'quick-add', 'title' => self::tt(), 'body' => self::tt(), 'action' => 'click']]] + $t, 'unknown field'],
            'tour step that submits' => ['tours', fn ($t) => ['steps' => [['target' => 'quick-add', 'title' => self::tt(), 'body' => self::tt(), 'submit' => true]]] + $t, 'unknown field'],
            'tour step with a CSS selector target' => ['tours', fn ($t) => ['steps' => [['target' => '#app > .btn', 'title' => self::tt(), 'body' => self::tt()]]] + $t, 'lower-case'],
            'tour step revealing something unknown' => ['tours', fn ($t) => ['steps' => [['target' => 'quick-add', 'reveal' => 'everything', 'title' => self::tt(), 'body' => self::tt()]]] + $t, 'reveal'],
            'tour with no steps' => ['tours', fn ($t) => ['steps' => []] + $t, '1 to 12'],
            'tour with too many steps' => ['tours', fn ($t) => ['steps' => array_fill(0, 13, ['target' => 'quick-add', 'title' => self::tt(), 'body' => self::tt()])] + $t, '1 to 12'],
            'tour step route outside the app' => ['tours', fn ($t) => ['steps' => [['target' => 'quick-add', 'route' => 'http://x', 'title' => self::tt(), 'body' => self::tt()]]] + $t, 'inside LifeOS'],
        ];
    }

    /** @return array<string, string> */
    public static function tt(): array
    {
        return ['ar' => 'ع', 'nl' => 'n', 'en' => 'e'];
    }

    #[DataProvider('invalid')]
    public function test_invalid_content_is_rejected(string $kind, callable $break, string $message): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->write('features', $this->feature('quick-capture'));
        $this->write('releases', $this->release('r-one'));
        $base = match ($kind) {
            'releases' => $this->release('r-one'), 'features' => $this->feature('quick-capture'), 'tours' => $this->tour('quick-tour')
        };
        $broken = $break($base);
        // The file keeps its original name even when the key inside is changed, which is what the "file name" case tests.
        $name = $base['key'] ?? $base['id'];
        file_put_contents("{$this->content}/{$kind}/{$name}.json", json_encode($broken, JSON_UNESCAPED_UNICODE));
        $this->expectException(InvalidDiscoveryContentException::class);
        $this->expectExceptionMessageMatches('/'.preg_quote($message, '/').'/i');
        $this->load()->releases();
    }

    public function test_a_file_that_is_not_an_object_is_rejected(): void
    {
        file_put_contents($this->content.'/releases/broken.json', '["a"]');
        $this->expectException(InvalidDiscoveryContentException::class);
        $this->load()->releases();
    }

    public function test_a_release_cannot_mention_a_feature_of_a_later_release(): void
    {
        $this->write('features', $this->feature('quick-capture', ['since' => 'r-later']));
        $this->write('releases', $this->release('r-later', ['date' => '2026-12-01']));
        $this->write('releases', $this->release('r-earlier', ['date' => '2026-11-01', 'items' => [['type' => 'new', 'feature' => 'quick-capture']]]));
        $this->expectException(InvalidDiscoveryContentException::class);
        $this->expectExceptionMessageMatches('/later release/');
        $this->load()->releases();
    }

    public function test_the_fingerprint_changes_with_any_text_a_person_would_read_and_with_nothing_else(): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->write('features', $this->feature('quick-capture', ['tour' => 'quick-tour']));
        $this->write('releases', $this->release('r-one'));
        $same = $this->load()->fingerprint('r-one');
        $this->assertSame($same, $this->load()->fingerprint('r-one'));
        $this->assertNull($this->load()->fingerprint('nope'));
        foreach ([
            ['releases', $this->release('r-one', ['summary' => $this->t('Other')])],
            ['features', $this->feature('quick-capture', ['tour' => 'quick-tour', 'description' => $this->t('Other')])],
            ['tours', $this->tour('quick-tour', ['title' => $this->t('Other')])],
        ] as [$kind, $data]) {
            $original = file_get_contents($this->content."/{$kind}/".($data['key'] ?? $data['id']).'.json');
            $this->write($kind, $data);
            $this->assertNotSame($same, $this->load()->fingerprint('r-one'), "a change in {$kind} must change the fingerprint");
            file_put_contents($this->content."/{$kind}/".($data['key'] ?? $data['id']).'.json', $original);
        }
        $this->assertSame($same, $this->load()->fingerprint('r-one'));
    }

    public function test_hint_ids_must_be_unique(): void
    {
        $hint = ['id' => 'same-hint', 'target' => 'quick-add', 'route' => '/tasks', 'text' => $this->t('x')];
        $this->write('features', $this->feature('quick-capture', ['hints' => [$hint]]));
        $this->write('features', $this->feature('another-one', ['hints' => [$hint]]));
        $this->write('releases', $this->release('r-one'));
        $this->expectException(InvalidDiscoveryContentException::class);
        $this->expectExceptionMessageMatches('/already used/');
        $this->load()->releases();
    }
}
