<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Per-connection synchronisation settings and the conflicts they can produce. Every existing account keeps today's behaviour: direction "inbound" (the provider is read on
 * the schedule and nothing is ever sent by itself), conflict policy "ask", not paused. A conflict is recorded when a copy LifeOS added was changed at the service as well
 * as in LifeOS; it holds only the LifeOS side's title and times, never provider payloads. Additive.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('calendar_accounts', function (Blueprint $table) {
            $table->string('sync_direction', 12)->default('inbound')->after('permissions_changed_at');
            $table->string('conflict_policy', 16)->default('ask')->after('sync_direction');
            $table->timestamp('sync_paused_at')->nullable()->after('conflict_policy');
        });
        Schema::create('sync_conflicts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('calendar_account_id')->constrained()->cascadeOnDelete();
            $table->unsignedBigInteger('calendar_write_link_id')->nullable()->index();
            $table->unsignedBigInteger('calendar_event_id')->nullable();
            $table->string('status', 10)->default('open');
            $table->string('resolution', 20)->nullable();
            $table->string('local_title', 255)->nullable();
            $table->timestamp('local_starts_at')->nullable();
            $table->timestamp('local_ends_at')->nullable();
            $table->timestamp('resolved_at')->nullable();
            $table->timestamps();
            $table->index(['calendar_account_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('sync_conflicts');
        Schema::table('calendar_accounts', function (Blueprint $table) {
            $table->dropColumn(['sync_direction', 'conflict_policy', 'sync_paused_at']);
        });
    }
};
