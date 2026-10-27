<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Optional id a device gives a task it created offline, so sending the same queued task twice (a lost response,
 * a retry) never creates a duplicate. Additive and nullable.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tasks', function (Blueprint $table) {
            $table->uuid('client_id')->nullable()->after('user_id');
            $table->unique(['user_id', 'client_id']);
        });
    }

    public function down(): void
    {
        Schema::table('tasks', function (Blueprint $table) {
            $table->dropUnique(['user_id', 'client_id']);
            $table->dropColumn('client_id');
        });
    }
};
