<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Signed event ids and retries for inbound webhooks. Purely additive, no backfill: existing endpoints keep accepting bodies without an event_id
 * (require_event_id = false) and existing deliveries keep their status.
 *
 *  - webhook_endpoints.require_event_id: when true, a delivery is accepted only if its signed JSON body carries an "event_id" equal to the
 *    X-LifeOS-Delivery header, so a captured request cannot be replayed under a new delivery id.
 *  - webhook_deliveries.attempts / last_error / next_attempt_at: how often the handlers ran, the last (redacted) failure and when the next
 *    automatic attempt is due, so failed deliveries can be diagnosed and processed again (lifeos:webhooks:failed, lifeos:webhooks:retry).
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('webhook_endpoints', 'require_event_id')) {
            Schema::table('webhook_endpoints', function (Blueprint $table) {
                $table->boolean('require_event_id')->default(false);
            });
        }
        if (! Schema::hasColumn('webhook_deliveries', 'attempts')) {
            Schema::table('webhook_deliveries', function (Blueprint $table) {
                $table->unsignedSmallInteger('attempts')->default(0);
                $table->string('last_error', 500)->nullable();
                $table->timestamp('next_attempt_at')->nullable();
                $table->index('status');
            });
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('webhook_deliveries', 'attempts')) {
            Schema::table('webhook_deliveries', function (Blueprint $table) {
                $table->dropIndex(['status']);
                $table->dropColumn(['attempts', 'last_error', 'next_attempt_at']);
            });
        }
        if (Schema::hasColumn('webhook_endpoints', 'require_event_id')) {
            Schema::table('webhook_endpoints', function (Blueprint $table) {
                $table->dropColumn('require_event_id');
            });
        }
    }
};
