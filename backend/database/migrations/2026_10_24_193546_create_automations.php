<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * User-owned automation rules and their execution log. Each (rule, subject) pair runs at most once.
     */
    public function up(): void
    {
        Schema::create('automation_rules', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('name', 120);
            $table->string('trigger', 40);
            $table->json('conditions')->nullable();
            $table->string('action', 40);
            $table->json('action_config')->nullable();
            $table->boolean('enabled')->default(true);
            $table->unsignedInteger('run_count')->default(0);
            $table->timestampTz('last_run_at')->nullable();
            $table->timestampsTz();
            $table->index(['user_id', 'trigger', 'enabled']);
        });
        Schema::create('automation_runs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('automation_rule_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('dedupe_key', 120);
            $table->string('status', 20);
            $table->string('subject', 120)->nullable();
            $table->text('message')->nullable();
            $table->json('result')->nullable();
            $table->unsignedSmallInteger('attempts')->default(0);
            $table->string('error', 300)->nullable();
            $table->timestampsTz();
            $table->unique(['automation_rule_id', 'dedupe_key']);
            $table->index(['user_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('automation_runs');
        Schema::dropIfExists('automation_rules');
    }
};
