<?php

namespace Tests\Feature;

use App\Models\AuditLog;
use App\Models\DailyCheckin;
use App\Models\FocusSession;
use App\Models\User;
use App\Models\UserSetting;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CheckinTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();
        $this->travelTo(CarbonImmutable::parse('2027-03-10 08:00', 'Europe/Amsterdam'));
        $this->user = User::factory()->create();
        UserSetting::create(['user_id' => $this->user->id, 'preferences' => ['timezone' => 'Europe/Amsterdam']]);
    }

    public function test_upsert_validates_scales_dates_and_is_one_per_day(): void
    {
        $this->actingAs($this->user)->putJson('/api/checkins/2027-03-10', ['energy' => 4, 'mood' => 3, 'sleep_minutes' => 450, 'reflection' => 'Good start'])->assertCreated()->assertJsonPath('energy', 4);
        $this->putJson('/api/checkins/2027-03-10', ['energy' => 2])->assertOk()->assertJsonPath('energy', 2)->assertJsonPath('mood', 3);
        $this->assertSame(1, DailyCheckin::count());

        $this->putJson('/api/checkins/2027-03-10', ['energy' => 6])->assertUnprocessable();
        $this->putJson('/api/checkins/2027-03-11', ['energy' => 3])->assertUnprocessable();
        $this->putJson('/api/checkins/2027-01-01', ['energy' => 3])->assertUnprocessable();
        $this->putJson('/api/checkins/2027-02-30', ['energy' => 3])->assertNotFound();
        $this->putJson('/api/checkins/2027-03-09', [])->assertUnprocessable();
        $this->getJson('/api/checkins')->assertOk()->assertJsonPath('today.energy', 2)->assertJsonPath('enabled', true);
    }

    public function test_checkins_are_private_to_their_owner(): void
    {
        DailyCheckin::create(['user_id' => $this->user->id, 'date' => '2027-03-09', 'energy' => 5, 'reflection' => 'Private note']);
        $other = User::factory()->create();

        $response = $this->actingAs($other)->getJson('/api/checkins')->assertOk()->assertJsonCount(0, 'items');
        $this->assertStringNotContainsString('Private note', $response->getContent());
        $this->actingAs($other)->deleteJson('/api/checkins/2027-03-09')->assertOk();
        $this->assertSame(1, DailyCheckin::count());
    }

    public function test_disabling_blocks_new_entries_and_history_can_be_deleted_after_password_confirmation(): void
    {
        DailyCheckin::create(['user_id' => $this->user->id, 'date' => '2027-03-09', 'energy' => 5]);
        $this->actingAs($this->user)->putJson('/api/settings', ['checkins_enabled' => false])->assertOk();
        $this->putJson('/api/checkins/2027-03-10', ['energy' => 3])->assertUnprocessable();
        $this->getJson('/api/checkins')->assertJsonPath('enabled', false);

        $this->deleteJson('/api/checkins')->assertStatus(423);
        $this->postJson('/api/security/confirm-password', ['password' => 'password'])->assertOk();
        $this->deleteJson('/api/checkins')->assertOk()->assertJsonPath('deleted', 1);
        $this->assertSame(0, DailyCheckin::where('user_id', $this->user->id)->count());
        $this->assertSame(1, AuditLog::where('action', 'checkins_deleted')->count());
    }

    public function test_insights_compare_energy_with_focus_only_with_enough_days(): void
    {
        $today = CarbonImmutable::now('Europe/Amsterdam')->startOfDay();
        foreach (range(1, 8) as $d) {
            $high = $d % 2 === 0;
            DailyCheckin::create(['user_id' => $this->user->id, 'date' => $today->subDays($d)->toDateString(), 'energy' => $high ? 5 : 1, 'workload' => 3]);
            FocusSession::create(['user_id' => $this->user->id, 'kind' => 'focus', 'status' => 'completed', 'duration_seconds' => 3600, 'elapsed_seconds' => $high ? 6000 : 1200, 'completed_at' => $today->subDays($d)->setTime(11, 0)->utc()]);
        }

        $insights = $this->actingAs($this->user)->getJson('/api/checkins/insights?days=30')->assertOk();
        $finding = collect($insights->json('findings'))->firstWhere('key', 'energy_focus_minutes');
        $this->assertSame('positive', $finding['type']);
        $this->assertSame([4, 4], array_column($finding['groups'], 'days'));
        $this->assertSame([100, 20], array_map('intval', array_column($finding['groups'], 'average')));
        $this->assertNull(collect($insights->json('findings'))->firstWhere('key', 'sleep_minutes_focus_minutes'), 'no sleep data, no claim');
        $this->assertStringContainsString('not medical advice', $insights->json('note.en'));
        $this->assertSame(8, $insights->json('checked_in_days'));
    }
}
