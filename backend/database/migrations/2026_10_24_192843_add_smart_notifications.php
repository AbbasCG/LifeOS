<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive only: notification categories, delivery tracking and browser push subscriptions.
     */
    public function up(): void
    {
        Schema::table('inbox_notifications', function (Blueprint $table) {
            $table->string('category', 20)->default('system')->after('kind');
            $table->text('body')->nullable()->after('title');
            $table->string('push_status', 20)->nullable()->after('link');
            $table->unsignedSmallInteger('push_attempts')->default(0)->after('push_status');
            $table->string('push_error', 200)->nullable()->after('push_attempts');
            $table->timestampTz('pushed_at')->nullable()->after('push_error');
            $table->index(['user_id', 'created_at']);
        });
        Schema::create('push_subscriptions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->char('endpoint_hash', 64)->unique();
            $table->text('endpoint');
            $table->text('public_key');
            $table->text('auth_token');
            $table->string('user_agent', 255)->nullable();
            $table->unsignedSmallInteger('failures')->default(0);
            $table->timestampTz('last_used_at')->nullable();
            $table->timestampsTz();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('push_subscriptions');
        Schema::table('inbox_notifications', function (Blueprint $table) {
            $table->dropIndex(['user_id', 'created_at']);
            $table->dropColumn(['category', 'body', 'push_status', 'push_attempts', 'push_error', 'pushed_at']);
        });
    }
};
