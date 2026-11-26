<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Links between an item in an external system (an EMC ticket first) and the LifeOS task created for it. Purely additive.
 *
 *  - integration_links: one row per user, source, external account and external id. It keeps the last applied `version` (events with an equal
 *    or lower version are stale), the external state, and the values the source sent last time (remote_*), which is what lets a later update
 *    change only the fields the person has not edited in LifeOS. task_id is set null when the person deletes the task, so the link stays and
 *    a plain update does not bring the task back.
 *  - webhook_endpoints.account_key: which external account an endpoint receives for (null for existing endpoints, which are unaffected).
 *    Unique per user and provider, so one user cannot get two endpoints for the same account by mistake.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('webhook_endpoints', 'account_key')) {
            Schema::table('webhook_endpoints', function (Blueprint $table) {
                $table->string('account_key', 64)->nullable();
                $table->unique(['user_id', 'provider_key', 'account_key']);
            });
        }
        if (! Schema::hasTable('integration_links')) {
            Schema::create('integration_links', function (Blueprint $table) {
                $table->id();
                $table->foreignId('user_id')->constrained()->cascadeOnDelete();
                $table->foreignId('webhook_endpoint_id')->nullable()->constrained()->nullOnDelete();
                $table->string('source', 40);
                $table->string('account_key', 64);
                $table->string('external_id', 200);
                $table->foreignId('task_id')->nullable()->constrained()->nullOnDelete();
                $table->unsignedBigInteger('version')->default(0);
                $table->string('last_event_id', 120)->nullable();
                $table->string('remote_state', 20);
                $table->string('remote_title', 500);
                $table->string('remote_priority', 10);
                $table->timestampTz('remote_due_at')->nullable();
                $table->boolean('remote_due_all_day')->default(false);
                $table->string('remote_url', 1000)->nullable();
                $table->string('remote_assignee', 200)->nullable();
                $table->boolean('closed_by_sync')->default(false);
                $table->timestampTz('synced_at')->nullable();
                $table->timestamps();
                $table->unique(['user_id', 'source', 'account_key', 'external_id']);
                $table->index('task_id');
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('integration_links');
        if (Schema::hasColumn('webhook_endpoints', 'account_key')) {
            Schema::table('webhook_endpoints', function (Blueprint $table) {
                $table->dropUnique(['user_id', 'provider_key', 'account_key']);
                $table->dropColumn('account_key');
            });
        }
    }
};
