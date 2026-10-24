<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Connected Life: per-account collection selection (calendars or task lists), read-only imported tasks,
 * and a source reference on LifeOS tasks copied from a connected app (prevents duplicates). Additive only.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('calendar_accounts', function (Blueprint $t) {
            // [{id, name, color, primary, included}] — null means the account predates selection (legacy behaviour).
            $t->json('collections')->nullable()->after('scopes');
        });
        Schema::create('external_tasks', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('calendar_account_id')->constrained()->cascadeOnDelete();
            $t->string('external_id', 512);
            $t->string('list_id', 512)->nullable();
            $t->string('list_name', 200)->nullable();
            $t->string('title', 500);
            $t->timestampTz('due_at')->nullable();
            $t->boolean('due_is_date')->default(true);
            $t->string('priority', 10)->nullable();
            $t->string('url', 1000)->nullable();
            $t->timestamps();
            $t->unique(['calendar_account_id', 'external_id']);
            $t->index(['user_id', 'due_at']);
        });
        Schema::table('tasks', function (Blueprint $t) {
            $t->string('source_ref', 600)->nullable();
            $t->unique(['user_id', 'source_ref']);
        });
    }

    public function down(): void
    {
        Schema::table('tasks', function (Blueprint $t) {
            $t->dropUnique(['user_id', 'source_ref']);
            $t->dropColumn('source_ref');
        });
        Schema::dropIfExists('external_tasks');
        Schema::table('calendar_accounts', function (Blueprint $t) {
            $t->dropColumn('collections');
        });
    }
};
