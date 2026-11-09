<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What LifeOS itself may do with one connected account (read, sync, import, export, create, update, delete). NULL means "never chosen": accounts connected before
 * this existed keep what they could already do (reading, syncing, importing and, where the person had allowed adding events, adding and changing those copies)
 * and are NOT given Delete. New connections store an explicit, minimal choice. Additive and nullable; nothing is rewritten.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('calendar_accounts', function (Blueprint $table) {
            $table->json('permissions')->nullable()->after('collections');
            $table->timestamp('permissions_changed_at')->nullable()->after('permissions');
        });
    }

    public function down(): void
    {
        Schema::table('calendar_accounts', function (Blueprint $table) {
            $table->dropColumn(['permissions', 'permissions_changed_at']);
        });
    }
};
