<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_settings', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->unique()->constrained()->cascadeOnDelete();
            $t->json('preferences');
            $t->timestamps();
        });
        foreach (['categories', 'projects', 'goals', 'habits'] as $table) {
            Schema::create($table, function (Blueprint $t) use ($table) {
                $t->id();
                $t->foreignId('user_id')->constrained()->cascadeOnDelete();
                $t->string('title');
                $t->text('description')->nullable();
                $t->string('color', 7)->default('#6366f1');
                if ($table === 'projects') {
                    $t->string('status')->default('active');
                    $t->timestampTz('due_at')->nullable();
                    $t->json('milestones')->nullable();
                }
                if ($table === 'goals') {
                    $t->unsignedInteger('target')->default(100);
                    $t->unsignedInteger('progress')->default(0);
                    $t->timestampTz('due_at')->nullable();
                }
                if ($table === 'habits') {
                    $t->string('recurrence')->default('daily');
                    $t->string('routine')->nullable();
                }
                $t->timestamps();
                $t->index(['user_id', 'created_at']);
            });
        }
        Schema::create('tasks', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('category_id')->nullable()->constrained()->nullOnDelete();
            $t->foreignId('project_id')->nullable()->constrained()->nullOnDelete();
            $t->string('title');
            $t->text('description')->nullable();
            $t->string('status')->default('inbox');
            $t->string('priority')->default('medium');
            $t->timestampTz('due_at')->nullable();
            $t->timestampTz('scheduled_start')->nullable();
            $t->timestampTz('scheduled_end')->nullable();
            $t->unsignedInteger('estimated_minutes')->default(30);
            $t->unsignedInteger('actual_minutes')->default(0);
            $t->timestampTz('completed_at')->nullable();
            $t->string('recurrence')->nullable();
            $t->json('subtasks')->nullable();
            $t->json('tags')->nullable();
            $t->text('notes')->nullable();
            $t->timestamps();
            $t->index(['user_id', 'status', 'due_at']);
        });
        Schema::create('calendar_events', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('task_id')->nullable()->constrained()->nullOnDelete();
            $t->string('title');
            $t->text('description')->nullable();
            $t->timestampTz('starts_at');
            $t->timestampTz('ends_at');
            $t->string('kind')->default('fixed');
            $t->timestamps();
            $t->index(['user_id', 'starts_at', 'ends_at']);
        });
        Schema::create('focus_sessions', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('task_id')->nullable()->constrained()->nullOnDelete();
            $t->string('kind')->default('focus');
            $t->string('status')->default('running');
            $t->unsignedInteger('duration_seconds');
            $t->unsignedInteger('elapsed_seconds')->default(0);
            $t->timestampTz('resumed_at')->nullable();
            $t->timestampTz('completed_at')->nullable();
            $t->timestamps();
            $t->index(['user_id', 'status']);
        });
        Schema::create('habit_entries', function (Blueprint $t) {
            $t->id();
            $t->foreignId('habit_id')->constrained()->cascadeOnDelete();
            $t->date('date');
            $t->timestamps();
            $t->unique(['habit_id', 'date']);
        });
        Schema::create('schedule_proposals', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('status')->default('pending');
            $t->json('items');
            $t->json('warnings');
            $t->timestamps();
        });
        Schema::create('inbox_notifications', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('title');
            $t->string('deduplication_key')->unique();
            $t->timestampTz('read_at')->nullable();
            $t->timestamps();
        });
    }

    public function down(): void
    {
        foreach (['inbox_notifications', 'schedule_proposals', 'habit_entries', 'focus_sessions', 'calendar_events', 'tasks', 'habits', 'goals', 'projects', 'categories', 'user_settings'] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
