<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Runtime state of each product release. The announcement text lives in reviewed JSON files; this table only records
 * whether the release was confirmed live by a successful deploy (deploy_status) and whether an administrator approved it
 * (review_status). A release is shown to users only when it is both approved and live.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_releases', function (Blueprint $table) {
            $table->id();
            $table->string('key', 64)->unique();
            $table->unsignedInteger('revision')->default(1);
            $table->string('importance', 12)->default('normal');
            $table->string('review_status', 12)->default('draft');
            $table->foreignId('reviewed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('reviewed_at')->nullable();
            // Fingerprints of the announcement as reviewed: what the administrator approved, and what the running code holds now.
            // A release is shown only while the two are equal, so changed text must be approved again.
            $table->string('approved_hash', 64)->nullable();
            $table->string('content_hash', 64)->nullable();
            $table->timestamp('published_at')->nullable();
            $table->string('deploy_status', 12)->default('live');
            $table->string('deployed_sha', 40)->nullable();
            $table->timestamp('live_since')->nullable();
            $table->timestamp('absent_since')->nullable();
            $table->timestamp('last_confirmed_at')->nullable();
            $table->timestamps();
            $table->index(['review_status', 'deploy_status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('product_releases');
    }
};
