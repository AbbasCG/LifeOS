<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive only: TOTP two-factor columns (secret and recovery hashes are encrypted by the model) and an audit log.
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $t) {
            $t->text('two_factor_secret')->nullable()->after('password');
            $t->text('two_factor_recovery_codes')->nullable()->after('two_factor_secret');
            $t->timestampTz('two_factor_confirmed_at')->nullable()->after('two_factor_recovery_codes');
            $t->unsignedBigInteger('two_factor_last_step')->nullable()->after('two_factor_confirmed_at');
        });
        Schema::create('audit_logs', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('action', 60);
            $t->string('ip_address', 45)->nullable();
            $t->string('user_agent', 255)->nullable();
            $t->json('meta')->nullable();
            $t->timestampTz('created_at')->useCurrent();
            $t->index(['user_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_logs');
        Schema::table('users', function (Blueprint $t) {
            $t->dropColumn(['two_factor_secret', 'two_factor_recovery_codes', 'two_factor_confirmed_at', 'two_factor_last_step']);
        });
    }
};
