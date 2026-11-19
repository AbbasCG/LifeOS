<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Task;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** Deleting the account works end to end: it was a 500 because the sign-out step was called without its audit logger. */
class AccountDeletionTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_account_and_its_data_are_deleted_and_the_session_ends(): void
    {
        $user = User::factory()->create(['password' => 'a-long-password-1']);
        $other = User::factory()->create();
        Task::factory()->create(['user_id' => $user->id]);
        $keep = Task::factory()->create(['user_id' => $other->id]);
        CalendarEvent::factory()->create(['user_id' => $user->id, 'starts_at' => '2027-02-03 09:00:00', 'ends_at' => '2027-02-03 10:00:00']);

        $this->actingAs($user)->deleteJson('/api/account', ['password' => 'a-long-password-1'])->assertOk()->assertJsonPath('message', 'Account deleted.');

        $this->assertNull(User::find($user->id));
        $this->assertSame(0, Task::where('user_id', $user->id)->count());
        $this->assertSame(0, CalendarEvent::where('user_id', $user->id)->count());
        $this->assertNotNull(Task::find($keep->id), 'another account is untouched');
        $this->assertGuest('web');
    }

    public function test_a_wrong_password_deletes_nothing(): void
    {
        $user = User::factory()->create(['password' => 'a-long-password-1']);
        $this->actingAs($user)->deleteJson('/api/account', ['password' => 'wrong-password'])->assertUnprocessable()->assertJsonValidationErrors('password');
        $this->assertNotNull(User::find($user->id));
    }

    public function test_a_guest_cannot_delete_anything(): void
    {
        $this->deleteJson('/api/account', ['password' => 'x'])->assertUnauthorized();
    }
}
