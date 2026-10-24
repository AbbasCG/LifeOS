<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive only: plan horizon/summary metadata and persisted weekly reviews.
     */
    public function up(): void
    {
        Schema::table('schedule_proposals', function (Blueprint $t) {
            $t->date('starts_on')->nullable()->after('status');
            $t->unsignedSmallInteger('days')->default(1)->after('starts_on');
            $t->json('summary')->nullable()->after('warnings');
            $t->timestampTz('accepted_at')->nullable()->after('summary');
            $t->index(['user_id', 'created_at']);
        });
        Schema::create('weekly_reviews', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->date('week_start');
            $t->string('status', 20)->default('draft');
            $t->json('reflection')->nullable();
            $t->json('decisions')->nullable();
            $t->json('priorities')->nullable();
            $t->json('snapshot')->nullable();
            $t->timestampTz('completed_at')->nullable();
            $t->timestamps();
            $t->unique(['user_id', 'week_start']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('weekly_reviews');
        Schema::table('schedule_proposals', function (Blueprint $t) {
            $t->dropIndex(['user_id', 'created_at']);
            $t->dropColumn(['starts_on', 'days', 'summary', 'accepted_at']);
        });
    }
};
