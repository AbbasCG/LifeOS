<?php

namespace Tests\Feature;

use App\Models\CalendarEvent;
use App\Models\Category;
use App\Models\FocusSession;
use App\Models\Goal;
use App\Models\Habit;
use App\Models\HabitEntry;
use App\Models\InboxNotification;
use App\Models\Project;
use App\Models\ScheduleProposal;
use App\Models\Task;
use App\Models\UserSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class FactoryTest extends TestCase
{
    use RefreshDatabase;

    public function test_model_factories_create_valid_records(): void
    {
        foreach ([Category::class, Project::class, Goal::class, Habit::class, HabitEntry::class, Task::class, CalendarEvent::class, FocusSession::class, InboxNotification::class, ScheduleProposal::class, UserSetting::class] as $model) {
            $this->assertTrue($model::factory()->create()->exists, $model);
        }
        $this->assertSame('completed', Task::factory()->completed()->create()->status);
        $this->assertTrue(Task::factory()->overdue()->create()->due_at->isPast());
        $this->assertSame('weekly', Task::factory()->recurring('weekly')->create()->recurrence);
        $this->assertSame('flexible', CalendarEvent::factory()->flexible()->create()->kind);
        $this->assertSame('weekly', Habit::factory()->weekly()->create()->recurrence);
    }
}
