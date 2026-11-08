<?php

namespace Tests\Feature\Integrations;

use App\Integrations\Calendar\CalendarProviders;
use App\Integrations\Manifest\InvalidManifestException;
use App\Integrations\Manifest\ManifestRegistry;
use Tests\TestCase;

class ManifestRegistryTest extends TestCase
{
    public function test_every_shipped_manifest_is_valid_bilingual_and_has_a_unique_id(): void
    {
        $all = app(ManifestRegistry::class)->all();
        $this->assertGreaterThanOrEqual(14, count($all));
        foreach ($all as $id => $manifest) {
            $public = $manifest->toPublic();
            $this->assertSame($id, $public['id']);
            $this->assertMatchesRegularExpression('/\p{Arabic}/u', $public['description']['ar'], "{$id} needs an Arabic description");
            $this->assertNotSame($public['description']['en'], $public['description']['ar']);
            $this->assertArrayNotHasKey('client_secret', $public);
        }
    }

    public function test_the_providers_that_exist_in_code_are_exactly_the_available_manifests(): void
    {
        $registry = app(ManifestRegistry::class);
        $implemented = ['google', 'outlook', 'google_tasks', 'microsoft_todo', 'todoist', 'ics'];
        $this->assertEqualsCanonicalizing($implemented, $registry->availableIds());
        foreach ($implemented as $id) {
            $this->assertNotNull(app(CalendarProviders::class)->get($id), "{$id} has a connector class");
        }
        foreach ($registry->all() as $id => $manifest) {
            if (! $manifest->isAvailable()) {
                $this->assertNull(app(CalendarProviders::class)->get($id), "{$id} is planned and must not be connectable");
            }
        }
    }

    public function test_the_auth_type_is_honest_about_pkce(): void
    {
        $registry = app(ManifestRegistry::class);
        $this->assertSame('oauth2', $registry->find('todoist')->auth(), 'Todoist does not send a PKCE challenge');
        $this->assertSame('oauth2_pkce', $registry->find('google')->auth());
        $this->assertSame('ics', $registry->find('ics')->auth());
        $this->assertFalse($registry->find('ics')->requiresAdminSetup());
    }

    public function test_an_invalid_manifest_is_rejected_with_a_clear_reason(): void
    {
        $dir = sys_get_temp_dir().'/manifests-'.bin2hex(random_bytes(4));
        mkdir($dir);
        $valid = ['id' => 'demo', 'category' => 'tasks', 'auth' => 'oauth2_pkce', 'status' => 'available', 'name' => ['en' => 'Demo', 'ar' => 'تجريبي'], 'description' => ['en' => 'x', 'ar' => 'ص'], 'scopes' => [], 'capabilities' => [], 'multi_account' => true, 'requires_admin_setup' => true];
        $cases = [
            'wrong file name' => [['id' => 'other'] + $valid, 'file name'],
            'unknown category' => [['category' => 'nope'] + $valid, 'category'],
            'unknown auth' => [['auth' => 'magic'] + $valid, 'auth'],
            'missing arabic' => [['description' => ['en' => 'x', 'ar' => '']] + $valid, 'description.ar'],
            'insecure docs' => [['docs_url' => 'http://example.com'] + $valid, 'https'],
            'bad scope' => [['scopes' => [['id' => 'a']]] + $valid, 'scope'],
        ];
        foreach ($cases as $name => [$data, $message]) {
            array_map('unlink', glob($dir.'/*.json'));
            file_put_contents($dir.'/demo.json', json_encode($data));
            try {
                (new ManifestRegistry($dir))->all();
                $this->fail("{$name} should be rejected");
            } catch (InvalidManifestException $e) {
                $this->assertStringContainsString($message, $e->getMessage(), $name);
            }
        }
        array_map('unlink', glob($dir.'/*.json'));
        file_put_contents($dir.'/demo.json', json_encode($valid));
        $this->assertSame(['demo'], array_keys((new ManifestRegistry($dir))->all()));
        array_map('unlink', glob($dir.'/*.json'));
        rmdir($dir);
    }
}
