<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What one person has done with an announcement, a feature, a tour or a hint. Only keys and timestamps are stored: no text,
 * no task or note content. The aggregate counts of these columns are the only usage measurement.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_discovery_states', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('subject_type', 12);
            $table->string('subject_key', 64);
            $table->unsignedSmallInteger('version')->default(1);
            $table->timestamp('seen_at')->nullable();
            $table->timestamp('tried_at')->nullable();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->timestamp('skipped_at')->nullable();
            $table->timestamp('dismissed_at')->nullable();
            $table->timestamp('snoozed_until')->nullable();
            $table->timestamp('notified_at')->nullable();
            $table->unsignedTinyInteger('snooze_count')->default(0);
            $table->unsignedSmallInteger('step_index')->default(0);
            $table->boolean('helpful')->nullable();
            $table->string('surface', 8)->nullable();
            $table->timestamps();
            $table->unique(['user_id', 'subject_type', 'subject_key', 'version'], 'user_discovery_unique');
            $table->index(['subject_type', 'subject_key']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_discovery_states');
    }
};
