<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * An administrator can stop NEW connections to a provider without touching the accounts that are already connected (their tokens keep refreshing and
 * syncing). That is a separate switch from `enabled`, which only says whether this row's client id and secret are in use. A row may exist with no client
 * id or secret at all, so a provider configured through the environment can be switched off too. Additive; every existing row stays unblocked.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('integration_app_credentials', function (Blueprint $table) {
            $table->timestamp('connections_blocked_at')->nullable()->after('enabled');
        });
    }

    public function down(): void
    {
        Schema::table('integration_app_credentials', function (Blueprint $table) {
            $table->dropColumn('connections_blocked_at');
        });
    }
};
