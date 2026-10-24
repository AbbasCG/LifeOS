<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive: focus modes, project link, notes, distraction log, actual start time and an idempotency key.
     */
    public function up(): void
    {
        Schema::table('focus_sessions', function (Blueprint $table) {
            $table->string('mode', 20)->nullable()->after('kind');
            $table->foreignId('project_id')->nullable()->after('task_id')->constrained()->nullOnDelete();
            $table->unsignedSmallInteger('cycle')->nullable()->after('mode');
            $table->text('notes')->nullable();
            $table->json('interruptions')->nullable();
            $table->timestampTz('started_at')->nullable();
            $table->uuid('client_id')->nullable();
            $table->unique(['user_id', 'client_id']);
            $table->index(['user_id', 'completed_at']);
        });
    }

    public function down(): void
    {
        Schema::table('focus_sessions', function (Blueprint $table) {
            $table->dropUnique(['user_id', 'client_id']);
            $table->dropIndex(['user_id', 'completed_at']);
            $table->dropConstrainedForeignId('project_id');
            $table->dropColumn(['mode', 'cycle', 'notes', 'interruptions', 'started_at', 'client_id']);
        });
    }
};
