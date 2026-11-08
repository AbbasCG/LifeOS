<?php

namespace Tests\Feature\Discovery;

use App\Services\Discovery\DiscoveryRegistry;

/** What an administrator sees before approving: the exact text, in all three languages, from the same scope as the fingerprint. */
class AdminPreviewTest extends DiscoveryTestCase
{
    private function draft(array $tour = []): void
    {
        $this->write('tours', $this->tour('quick-tour', $tour));
        $this->publishable(['items' => [['type' => 'new', 'feature' => 'quick-capture'], ['type' => 'fixed', 'title' => $this->t('Sign-out fix'), 'body' => $this->t('Waiting changes are kept'), 'link' => '/updates']]], ['tour' => 'quick-tour']);
    }

    public function test_the_list_shows_the_text_an_administrator_approves_in_all_languages(): void
    {
        $this->draft();
        $this->actingAs($this->admin());
        $release = $this->getJson('/api/admin/discovery/releases')->assertOk()->json('data.0');
        $preview = $release['preview'];
        $this->assertSame($this->t('Title'), $preview['title']);
        $this->assertSame($this->t('Summary'), $preview['summary']);
        $this->assertSame(['web', 'mobile'], $preview['audiences']);
        $this->assertCount(2, $preview['items']);
        $this->assertSame('quick-capture', $preview['items'][0]['feature']);
        $this->assertSame($this->t('Waiting changes are kept'), $preview['items'][1]['body']);
        $this->assertSame('/updates', $preview['items'][1]['link']);
        $this->assertSame($this->t('Quick capture'), $preview['features'][0]['name']);
        $this->assertSame('quick-tour', $preview['features'][0]['tour']);
        $this->assertSame('quick-tour', $preview['tours'][0]['id']);
        $this->assertSame($this->t('Body'), $preview['tours'][0]['steps'][0]['body']);
        $this->assertSame('quick-add', $preview['tours'][0]['steps'][0]['target']);
    }

    public function test_what_is_shown_and_what_is_approved_change_together(): void
    {
        $this->draft();
        $this->actingAs($this->admin());
        $before = $this->getJson('/api/admin/discovery/releases')->json('data.0');
        // Reword one tour step: the fingerprint moves, and so does the previewed step.
        $this->draft(['steps' => [['target' => 'quick-add', 'title' => $this->t('Step'), 'body' => $this->t('New wording')]]]);
        $after = $this->getJson('/api/admin/discovery/releases')->json('data.0');
        $this->assertNotSame($before['content_hash'], $after['content_hash']);
        $this->assertSame($this->t('New wording'), $after['preview']['tours'][0]['steps'][0]['body']);
        $this->assertSame($this->hash('r-one'), $after['content_hash']);
    }

    public function test_nobody_else_sees_the_preview(): void
    {
        $this->draft();
        $this->getJson('/api/admin/discovery/releases')->assertUnauthorized();
        $this->actingAs($this->member());
        $this->getJson('/api/admin/discovery/releases')->assertForbidden()->assertJsonMissingPath('data');
    }

    public function test_the_fingerprint_of_a_release_is_unchanged_by_how_the_scope_is_read(): void
    {
        $this->draft();
        $registry = app(DiscoveryRegistry::class);
        $scope = $registry->scope('r-one');
        $this->assertSame(hash('sha256', json_encode([$scope['release'], $scope['features'], $scope['tours']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)), $registry->fingerprint('r-one'));
        $this->assertNull($registry->scope('nope'));
        $this->assertNull($registry->fingerprint('nope'));
    }
}
