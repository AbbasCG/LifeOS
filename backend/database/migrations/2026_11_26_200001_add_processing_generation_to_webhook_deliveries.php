<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * webhook_deliveries.processing_generation: which queued job may still change a delivery. Every requeue (lifeos:webhooks:retry, a redelivery
 * of a failed event, a stuck delivery) increments it and queues a job carrying the new value; a job, its retries and its failed() hook only
 * write to the row while the generation matches, so a late job from an earlier attempt can no longer overwrite the newer one.
 *
 * Purely additive with default 0: jobs already in the queue carry no generation (0) and still match every existing row.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('webhook_deliveries', 'processing_generation')) {
            Schema::table('webhook_deliveries', function (Blueprint $table) {
                $table->unsignedInteger('processing_generation')->default(0);
            });
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('webhook_deliveries', 'processing_generation')) {
            Schema::table('webhook_deliveries', function (Blueprint $table) {
                $table->dropColumn('processing_generation');
            });
        }
    }
};
