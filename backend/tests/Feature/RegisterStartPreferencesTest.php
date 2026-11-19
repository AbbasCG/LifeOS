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
        $this->assertSame(['timezone' => 'Asia/Riyadh', 'language' => 'ar'], UserSetting::where('user_id', $user->id)->firstOrFail()->preferences);
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('timezone', 'Asia/Riyadh')->assertJsonPath('language', 'ar');
    }

    public function test_a_retired_zone_name_from_an_older_browser_is_stored_under_its_current_name(): void
    {
        $this->register(['timezone' => 'Asia/Calcutta'])->assertCreated();
        $this->assertSame('Asia/Kolkata', User::where('email', 'sara@example.test')->firstOrFail()->timezone());
        // The stored name is one the settings screen accepts when it is saved again.
        $this->putJson('/api/settings', ['timezone' => 'Asia/Kolkata'])->assertOk();
    }

    public function test_without_them_nothing_changes(): void
    {
        $this->register()->assertCreated();
        $user = User::where('email', 'sara@example.test')->firstOrFail();
        $this->assertSame('UTC', $user->timezone());
        $this->assertSame(0, UserSetting::where('user_id', $user->id)->count());
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

    public function test_a_new_account_reads_a_complete_work_week_and_theme(): void
    {
        // The row made at signup holds only the zone and language; the screens still need every value.
        $this->register(['timezone' => 'Asia/Riyadh', 'language' => 'ar'])->assertCreated();
        $this->getJson('/api/settings')->assertOk()
            ->assertJsonPath('timezone', 'Asia/Riyadh')->assertJsonPath('language', 'ar')
            ->assertJsonPath('work_start', '09:00')->assertJsonPath('work_end', '17:00')->assertJsonPath('work_days', [1, 2, 3, 4, 5])
            ->assertJsonPath('break_minutes', 10)->assertJsonPath('theme', 'system')->assertJsonPath('week_start', 1);
        $this->putJson('/api/settings', ['theme' => 'dark'])->assertOk()->assertJsonPath('work_days', [1, 2, 3, 4, 5])->assertJsonPath('theme', 'dark');
    }

    public function test_without_a_zone_the_settings_show_the_zone_the_account_really_uses(): void
    {
        $this->actingAs(User::factory()->create());
        UserSetting::create(['user_id' => auth()->id(), 'preferences' => ['language' => 'en']]);
        $this->getJson('/api/settings')->assertOk()->assertJsonPath('timezone', 'UTC')->assertJsonPath('work_days', [1, 2, 3, 4, 5]);
    }
}
