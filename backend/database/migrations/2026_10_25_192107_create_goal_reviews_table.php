<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * V18: one snapshot per goal and month, so a goal review can say how the goal moved since the previous one.
 * Additive only.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('goal_reviews', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('goal_id')->constrained()->cascadeOnDelete();
            $t->date('period_start');
            $t->date('period_end');
            $t->unsignedTinyInteger('percent');
            $t->unsignedInteger('tasks_done')->default(0);
            $t->unsignedInteger('focus_minutes')->default(0);
            $t->string('status', 20);
            $t->timestamps();
            $t->unique(['goal_id', 'period_start']);
            $t->index(['user_id', 'period_start']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('goal_reviews');
    }
};
