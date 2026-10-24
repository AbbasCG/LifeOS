<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive only: task reminders and richer in-app notifications.
     */
    public function up(): void
    {
        Schema::table('tasks', function (Blueprint $t) {
            $t->timestampTz('remind_at')->nullable()->after('due_at');
            $t->index(['user_id', 'remind_at']);
        });
        Schema::table('inbox_notifications', function (Blueprint $t) {
            $t->string('kind', 30)->default('info')->after('title');
            $t->string('link', 200)->nullable()->after('kind');
            $t->index(['user_id', 'read_at']);
        });
    }

    public function down(): void
    {
        Schema::table('inbox_notifications', function (Blueprint $t) {
            $t->dropIndex(['user_id', 'read_at']);
            $t->dropColumn(['kind', 'link']);
        });
        Schema::table('tasks', function (Blueprint $t) {
            $t->dropIndex(['user_id', 'remind_at']);
            $t->dropColumn('remind_at');
        });
    }
};
