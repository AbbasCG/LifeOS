<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A pending authorization can name the connected account it is for (the second consent that adds the write permission to an account that already
 * exists), so that part of the flow no longer needs the browser session either. Additive and nullable; existing rows are unaffected.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('oauth_states', function (Blueprint $table) {
            $table->foreignId('account_id')->nullable()->after('provider')->constrained('calendar_accounts')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('oauth_states', function (Blueprint $table) {
            $table->dropConstrainedForeignId('account_id');
        });
    }
};
