<?php

namespace Tests\Feature\Discovery;

use App\Models\ProductRelease;
use App\Models\User;
use App\Models\UserDiscoveryState;
use App\Services\Discovery\DiscoveryStateService;
use App\Services\Discovery\ReleaseService;
use Illuminate\Testing\TestResponse;

/** The progress API: only real subjects, only known actions, and a state only moves forward. */
class DiscoveryStateTest extends DiscoveryTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->write('tours', $this->tour('quick-tour'));
        $this->publishable([], ['tour' => 'quick-tour', 'hints' => [['id' => 'qc-hint', 'target' => 'quick-add', 'route' => '/tasks', 'text' => $this->t('Try')]]]);
        $this->goLive();
        $this->actingAs($this->member());
    }

    private function act(string $type, string $key, array $body): TestResponse
    {
        return $this->putJson("/api/discovery/states/{$type}/{$key}", $body);
    }

    public function test_only_existing_subjects_can_have_a_state(): void
    {
        $this->act('release', 'r-one', ['action' => 'seen'])->assertOk();
        $this->act('feature', 'quick-capture', ['action' => 'seen'])->assertOk();
        $this->act('tour', 'quick-tour', ['action' => 'started'])->assertOk();
        $this->act('hint', 'qc-hint', ['action' => 'dismissed'])->assertOk();
        foreach ([['release', 'nope'], ['feature', 'nope'], ['tour', 'nope'], ['hint', 'nope'], ['widget', 'r-one']] as [$type, $key]) {
            $this->act($type, $key, ['action' => 'seen'])->assertNotFound();
        }
        $this->assertSame(4, UserDiscoveryState::count(), 'no stray rows from invalid keys');
    }

    public function test_an_unpublished_release_has_no_state(): void
    {
        ProductRelease::query()->update(['review_status' => 'withdrawn']);
        $this->act('release', 'r-one', ['action' => 'seen'])->assertNotFound();
        $this->act('feature', 'quick-capture', ['action' => 'seen'])->assertNotFound();
        $this->act('hint', 'qc-hint', ['action' => 'seen'])->assertNotFound();
    }

    public function test_actions_and_fields_are_validated(): void
    {
        $this->act('release', 'r-one', ['action' => 'explode'])->assertUnprocessable();
        $this->act('release', 'r-one', [])->assertUnprocessable();
        $this->act('tour', 'quick-tour', ['action' => 'step', 'step_index' => -1])->assertUnprocessable();
        $this->act('tour', 'quick-tour', ['action' => 'step', 'step_index' => 9999])->assertUnprocessable();
        $this->act('release', 'r-one', ['action' => 'seen', 'surface' => 'tv'])->assertUnprocessable();
    }

    public function test_only_keys_and_timestamps_are_stored_whatever_the_client_sends(): void
    {
        $this->act('release', 'r-one', ['action' => 'seen', 'note' => 'my private note', 'title' => 'secret task'])->assertOk()->assertJsonMissingPath('data.note');
        $columns = array_keys(UserDiscoveryState::first()->getAttributes());
        $this->assertSame([], array_values(array_intersect($columns, ['note', 'title', 'text', 'body', 'content'])));
        $this->assertStringNotContainsString('private', json_encode(UserDiscoveryState::first()->getAttributes()));
    }

    public function test_a_tour_progresses_and_a_finished_tour_cannot_go_backwards(): void
    {
        $this->act('tour', 'quick-tour', ['action' => 'started'])->assertOk()->assertJsonPath('data.step_index', 0);
        $this->act('tour', 'quick-tour', ['action' => 'step', 'step_index' => 3])->assertOk()->assertJsonPath('data.step_index', 3);
        $done = $this->act('tour', 'quick-tour', ['action' => 'completed'])->assertOk()->json('data.completed_at');
        $this->assertNotNull($done);
        $after = $this->act('tour', 'quick-tour', ['action' => 'started'])->json('data');
        $this->act('tour', 'quick-tour', ['action' => 'step', 'step_index' => 0])->assertOk()->assertJsonPath('data.step_index', 3);
        $this->act('tour', 'quick-tour', ['action' => 'skipped'])->assertOk()->assertJsonPath('data.skipped_at', null);
        $this->assertSame($done, $after['completed_at']);
    }

    public function test_the_first_seen_time_is_kept_and_a_state_is_one_row_per_subject(): void
    {
        $first = $this->act('feature', 'quick-capture', ['action' => 'seen'])->json('data.seen_at');
        $this->travel(2)->hours();
        $second = $this->act('feature', 'quick-capture', ['action' => 'seen'])->json('data.seen_at');
        $this->assertSame($first, $second);
        $this->assertSame(1, UserDiscoveryState::where('subject_type', 'feature')->count());
    }

    public function test_a_rewritten_tour_keeps_its_old_progress_separate(): void
    {
        $this->act('tour', 'quick-tour', ['action' => 'completed'])->assertOk();
        $this->write('tours', $this->tour('quick-tour', ['version' => 2]));
        $this->reapprove();   // a rewritten tour is new text: it needs a new approval
        $this->app->forgetInstance(ReleaseService::class);
        $this->app->forgetInstance(DiscoveryStateService::class);
        $this->act('tour', 'quick-tour', ['action' => 'started'])->assertOk()->assertJsonPath('data.version', 2)->assertJsonPath('data.completed_at', null);
        $this->assertSame(2, UserDiscoveryState::where('subject_type', 'tour')->count());
    }

    public function test_helpful_or_not_is_a_yes_or_no_only(): void
    {
        $this->act('release', 'r-one', ['action' => 'helpful'])->assertOk()->assertJsonPath('data.helpful', true);
        $this->act('release', 'r-one', ['action' => 'unhelpful'])->assertOk()->assertJsonPath('data.helpful', false);
        $this->getJson('/api/discovery/releases')->assertJsonPath('data.0.helpful', false);
    }

    public function test_administrator_only_features_and_their_tours_do_not_exist_for_everyone_else(): void
    {
        $this->write('tours', $this->tour('admin-tour'));
        $this->write('features', $this->feature('admin-tool', ['requires' => ['admin'], 'tour' => 'admin-tour', 'hints' => [['id' => 'admin-hint', 'target' => 'admin-x', 'route' => '/tasks', 'text' => $this->t('x')]]]));
        $this->reapprove();
        $this->act('feature', 'admin-tool', ['action' => 'seen'])->assertNotFound();
        $this->act('tour', 'admin-tour', ['action' => 'started'])->assertNotFound();
        $this->act('hint', 'admin-hint', ['action' => 'seen'])->assertNotFound();
        $this->actingAs($this->admin(false));
        $this->act('feature', 'admin-tool', ['action' => 'seen'])->assertOk();
        $this->act('tour', 'admin-tour', ['action' => 'started'])->assertOk();
    }

    public function test_a_tour_of_a_feature_that_is_not_published_has_no_state(): void
    {
        $this->write('tours', $this->tour('orphan-tour'));
        $this->write('features', $this->feature('later-feature', ['since' => 'r-later', 'tour' => 'orphan-tour']));
        $this->write('releases', $this->release('r-later', ['date' => '2026-12-01', 'items' => [['type' => 'new', 'feature' => 'later-feature']]]));
        $this->reapprove();
        $this->act('tour', 'orphan-tour', ['action' => 'started'])->assertNotFound();
    }

    public function test_a_second_tap_on_later_and_a_tap_after_the_end_change_nothing(): void
    {
        $first = $this->act('release', 'r-one', ['action' => 'snoozed'])->json('data');
        $again = $this->act('release', 'r-one', ['action' => 'snoozed'])->json('data');
        $this->assertSame($first['snoozed_until'], $again['snoozed_until']);
        $this->assertSame(1, UserDiscoveryState::first()->snooze_count);
        UserDiscoveryState::query()->update(['dismissed_at' => now()]);
        $this->act('release', 'r-one', ['action' => 'snoozed'])->assertOk();
        $this->assertSame(1, UserDiscoveryState::first()->snooze_count, 'nothing is counted once it is history only');
    }

    public function test_deleting_the_account_removes_the_discovery_state(): void
    {
        $this->act('release', 'r-one', ['action' => 'seen'])->assertOk();
        $user = User::first();
        $this->assertGreaterThan(0, UserDiscoveryState::where('user_id', $user->id)->count());
        $user->delete();
        $this->assertSame(0, UserDiscoveryState::count());
    }
}
