<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * V9 personal intelligence. Additive and reversible:
 * - tasks remember how often their deadline was pushed later (to notice repeatedly postponed work);
 * - recommendations persist so they can be deduplicated, dismissed, snoozed, rated and expired.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tasks', function (Blueprint $t) {
            $t->unsignedSmallInteger('postponed_count')->default(0);
            $t->timestamp('last_postponed_at')->nullable();
        });
        Schema::create('recommendations', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            // Stable identity of the situation (e.g. "deadline:12:2027-03-23"), so the same advice is never repeated.
            $t->string('key', 191);
            $t->string('type', 40);
            $t->string('severity', 10);
            $t->string('status', 12)->default('active');
            $t->json('payload');
            $t->string('feedback', 12)->nullable();
            $t->timestamp('feedback_at')->nullable();
            $t->timestamp('dismissed_at')->nullable();
            $t->timestamp('snoozed_until')->nullable();
            $t->timestamp('acted_at')->nullable();
            $t->uuid('proposal_id')->nullable();
            $t->timestamp('first_seen_at');
            $t->timestamp('last_seen_at');
            $t->timestamps();
            $t->unique(['user_id', 'key']);
            $t->index(['user_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('recommendations');
        Schema::table('tasks', function (Blueprint $t) {
            $t->dropColumn(['postponed_count', 'last_postponed_at']);
        });
    }
};
