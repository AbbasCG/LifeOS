<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\UserSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** A new account starts in the zone and language the browser reported, so its first "today" and times are the person's own. */
class RegisterStartPreferencesTest extends TestCase
{
    use RefreshDatabase;

    private function register(array $extra = [])
    {
        return $this->postJson('/api/register', ['name' => 'Sara', 'email' => 'sara@example.test', 'password' => 'a-long-password-1', 'password_confirmation' => 'a-long-password-1'] + $extra);
    }

    public function test_the_browser_zone_and_language_become_the_starting_preferences(): void
    {
        $this->register(['timezone' => 'Asia/Riyadh', 'language' => 'ar'])->assertCreated();
        $user = User::where('email', 'sara@example.test')->firstOrFail();
        $this->assertSame('Asia/Riyadh', $user->timezone());
        $this->assertSame(['timezone' => 'Asia/Riyadh', 'language' => 'ar', 'onboarding' => 'pending', 'ui_mode' => 'simple'], UserSetting::where('user_id', $user->id)->firstOrFail()->preferences);
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('timezone', 'Asia/Riyadh')->assertJsonPath('language', 'ar');
    }

    public function test_a_retired_zone_name_from_an_older_browser_is_stored_under_its_current_name(): void
    {
        $this->register(['timezone' => 'Asia/Calcutta'])->assertCreated();
        $this->assertSame('Asia/Kolkata', User::where('email', 'sara@example.test')->firstOrFail()->timezone());
        // The stored name is one the settings screen accepts when it is saved again.
        $this->putJson('/api/settings', ['timezone' => 'Asia/Kolkata'])->assertOk();
    }

    public function test_without_them_the_zone_stays_utc_and_only_the_first_run_flags_are_stored(): void
    {
        $this->register()->assertCreated();
        $user = User::where('email', 'sara@example.test')->firstOrFail();
        $this->assertSame('UTC', $user->timezone());
        $this->assertSame(['onboarding' => 'pending', 'ui_mode' => 'simple'], UserSetting::where('user_id', $user->id)->firstOrFail()->preferences);
    }

    public function test_invalid_values_are_refused_and_no_account_is_created(): void
    {
        $this->register(['timezone' => 'Mars/Olympus'])->assertUnprocessable()->assertJsonValidationErrors('timezone');
        $this->register(['language' => 'fr'])->assertUnprocessable()->assertJsonValidationErrors('language');
        $this->assertSame(0, User::count());
    }

    public function test_the_extra_fields_never_reach_the_user_row(): void
    {
        $this->register(['timezone' => 'Europe/Amsterdam', 'is_admin' => true])->assertCreated();
        $this->assertFalse((bool) User::where('email', 'sara@example.test')->firstOrFail()->is_admin);
    }

    public function test_existing_accounts_keep_the_full_app_and_no_setup(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user)->getJson('/api/settings')->assertOk()->assertJsonPath('onboarding', 'done')->assertJsonPath('ui_mode', 'full');
    }

    public function test_the_setup_and_the_navigation_size_can_be_changed_and_are_validated(): void
    {
        $this->register()->assertCreated();
        $this->getJson('/api/settings')->assertJsonPath('onboarding', 'pending')->assertJsonPath('ui_mode', 'simple');
        $this->putJson('/api/settings', ['onboarding' => 'done', 'ui_mode' => 'full'])->assertOk()->assertJsonPath('onboarding', 'done')->assertJsonPath('ui_mode', 'full');
        $this->putJson('/api/settings', ['onboarding' => 'later'])->assertUnprocessable()->assertJsonValidationErrors('onboarding');
        $this->putJson('/api/settings', ['ui_mode' => 'tiny'])->assertUnprocessable()->assertJsonValidationErrors('ui_mode');
    }
}
