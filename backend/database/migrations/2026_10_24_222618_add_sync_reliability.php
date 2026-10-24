<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * V6 sync reliability (additive, reversible): incremental sync state, rate-limit back-off, stable provider identifiers,
 * change tracking for moved events, task completion status, and a sync run log for observability.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('calendar_accounts', function (Blueprint $t) {
            // {collection id: {token: string|null, full_at: ISO-8601}} — provider sync tokens / delta links per collection.
            $t->json('sync_state')->nullable();
            $t->timestampTz('last_attempt_at')->nullable();
            $t->timestampTz('retry_after')->nullable();
            $t->unsignedSmallInteger('consecutive_failures')->default(0);
            // null = provider did not report scopes; false = a required read scope was not granted.
            $t->boolean('scopes_ok')->nullable();
        });
        Schema::table('external_events', function (Blueprint $t) {
            $t->string('ical_uid', 1024)->nullable();
            $t->string('series_id', 512)->nullable();
            $t->timestampTz('original_start')->nullable();
            $t->string('timezone', 64)->nullable();
            $t->timestampTz('previous_starts_at')->nullable();
            $t->timestampTz('changed_at')->nullable();
            $t->index(['user_id', 'changed_at']);
        });
        Schema::table('external_tasks', function (Blueprint $t) {
            $t->string('status', 16)->default('open');
            $t->timestampTz('completed_at')->nullable();
        });
        Schema::create('sync_runs', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('calendar_account_id')->constrained()->cascadeOnDelete();
            $t->string('mode', 16)->default('full');
            $t->string('status', 16)->default('running');
            $t->string('trigger', 16)->default('scheduled');
            $t->timestampTz('started_at');
            $t->timestampTz('finished_at')->nullable();
            $t->unsignedInteger('upserted')->default(0);
            $t->unsignedInteger('removed')->default(0);
            $t->unsignedInteger('moved')->default(0);
            $t->string('error', 500)->nullable();
            $t->json('details')->nullable();
            $t->index(['calendar_account_id', 'started_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sync_runs');
        Schema::table('external_tasks', function (Blueprint $t) {
            $t->dropColumn(['status', 'completed_at']);
        });
        Schema::table('external_events', function (Blueprint $t) {
            $t->dropIndex(['user_id', 'changed_at']);
            $t->dropColumn(['ical_uid', 'series_id', 'original_start', 'timezone', 'previous_starts_at', 'changed_at']);
        });
        Schema::table('calendar_accounts', function (Blueprint $t) {
            $t->dropColumn(['sync_state', 'last_attempt_at', 'retry_after', 'consecutive_failures', 'scopes_ok']);
        });
    }
};
