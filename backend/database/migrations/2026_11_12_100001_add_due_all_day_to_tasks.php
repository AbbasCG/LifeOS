<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Date-only deadlines. Purely additive, no backfill: every existing row keeps due_all_day = false, i.e. exactly today's behaviour.
 *
 * tasks.due_all_day: when true, tasks.due_at is still a real instant, the END of that calendar day (23:59:00) in the account timezone, so all
 * overdue / ordering / reminder / planning logic keeps working on due_at unchanged. The flag only tells clients to show the date without a time.
 * NOT NULL DEFAULT false is a metadata-only change on PostgreSQL 11+ (no table rewrite) and a plain column add on SQLite. Guarded so a re-run is safe.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('tasks', 'due_all_day')) {
            Schema::table('tasks', function (Blueprint $table) {
                $table->boolean('due_all_day')->default(false);
            });
        }
    }

    public function down(): void
    {
        if (Schema::hasColumn('tasks', 'due_all_day')) {
            Schema::table('tasks', function (Blueprint $table) {
                $table->dropColumn('due_all_day');
            });
        }
    }
};
