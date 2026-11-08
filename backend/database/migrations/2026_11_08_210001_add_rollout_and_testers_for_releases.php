<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Staged rollout of product releases. `rollout` says who may see a release: "admin" (administrators only, a preview), "internal" (administrators and the
 * test accounts below) or "general" (everyone, which is what every existing release keeps, so nothing that is live changes). The audience of the
 * screen (web or mobile) is a different thing and stays in the content file. `discovery_testers` holds the test accounts: one row per account, no other data.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('product_releases', function (Blueprint $table) {
            $table->string('rollout', 10)->default('general')->after('review_status');
        });
        Schema::create('discovery_testers', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->unique()->constrained()->cascadeOnDelete();
            $table->foreignId('added_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('discovery_testers');
        Schema::table('product_releases', function (Blueprint $table) {
            $table->dropColumn('rollout');
        });
    }
};
