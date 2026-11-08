<?php

namespace Tests\Feature\Discovery;

use App\Models\UserSetting;

/** The tour a person is shown: localized, only when it belongs to a live, approved release they may use, with where they stopped. */
class TourEndpointTest extends DiscoveryTestCase
{
    private function live(array $feature = [], array $tour = []): void
    {
        $this->write('tours', $this->tour('quick-tour', $tour + ['steps' => [
            ['target' => 'quick-add', 'title' => $this->t('One'), 'body' => $this->t('First'), 'placement' => 'bottom'],
            ['target' => 'nav-tasks', 'reveal' => 'sidebar', 'route' => '/tasks', 'optional' => true, 'title' => $this->t('Two'), 'body' => $this->t('Second')],
        ]]));
        $this->publishable([], ['tour' => 'quick-tour'] + $feature);
        $this->goLive();
    }

    public function test_the_tour_is_returned_in_the_persons_language_with_its_steps(): void
    {
        $this->live();
        $user = $this->member();
        UserSetting::create(['user_id' => $user->id, 'preferences' => ['language' => 'nl']]);
        $this->actingAs($user);
        $this->getJson('/api/discovery/tours/quick-tour')->assertOk()
            ->assertJsonPath('data.title', 'nl Tour')->assertJsonCount(2, 'data.steps')
            ->assertJsonPath('data.steps.0.title', 'nl One')->assertJsonPath('data.steps.0.placement', 'bottom')
            ->assertJsonPath('data.steps.1.reveal', 'sidebar')->assertJsonPath('data.steps.1.route', '/tasks')->assertJsonPath('data.steps.1.optional', true)
            ->assertJsonPath('data.state', ['step_index' => 0, 'completed' => false, 'skipped' => false]);
    }

    public function test_where_the_person_stopped_is_remembered(): void
    {
        $this->live();
        $this->actingAs($this->member());
        $this->putJson('/api/discovery/states/tour/quick-tour', ['action' => 'step', 'step_index' => 1])->assertOk();
        $this->getJson('/api/discovery/tours/quick-tour')->assertJsonPath('data.state.step_index', 1);
        $this->putJson('/api/discovery/states/tour/quick-tour', ['action' => 'completed'])->assertOk();
        $this->getJson('/api/discovery/tours/quick-tour')->assertJsonPath('data.state.completed', true);
    }

    public function test_a_tour_nobody_may_see_is_a_404(): void
    {
        $this->live();
        $this->getJson('/api/discovery/tours/quick-tour')->assertUnauthorized();
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/tours/unknown-tour')->assertNotFound();
        $this->getJson('/api/discovery/tours/Bad_Id')->assertNotFound();
    }

    public function test_a_tour_of_an_unapproved_release_or_an_admin_only_feature_is_a_404(): void
    {
        $this->write('tours', $this->tour('quick-tour'));
        $this->publishable([], ['tour' => 'quick-tour']);
        $this->deploy();
        $this->artisan('lifeos:discovery:reconcile')->assertSuccessful();
        $this->actingAs($this->member());
        $this->getJson('/api/discovery/tours/quick-tour')->assertNotFound();
        $this->goLive();
        $this->getJson('/api/discovery/tours/quick-tour')->assertOk();
        $this->write('features', $this->feature('quick-capture', ['tour' => 'quick-tour', 'requires' => ['admin']]));
        $this->reapprove();
        $this->getJson('/api/discovery/tours/quick-tour')->assertNotFound();
    }
}
