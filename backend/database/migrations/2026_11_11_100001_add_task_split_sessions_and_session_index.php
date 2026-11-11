<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * One active session per ordinary task (see App\Services\TaskScheduler). Purely additive, no backfill: existing rows are untouched.
 *
 *  - tasks.split_sessions: true for a task the user explicitly works in several blocks (an accepted multi-block plan). Defaults to false.
 *  - calendar_events(user_id, task_id, ends_at): "the active sessions of this task" and the duplicates report.
 *
 * The index is built CONCURRENTLY on PostgreSQL (no write lock on calendar_events while it builds), which cannot run inside a transaction, hence
 * $withinTransaction = false. An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS would silently keep, so an invalid one is
 * dropped first and the migration can simply be run again. Other drivers (SQLite in tests) use an ordinary index guarded by Schema::hasIndex.
 */
return new class extends Migration
{
    public $withinTransaction = false;

    private const INDEX = 'calendar_events_user_task_ends_index';

    public function up(): void
    {
        if (! Schema::hasColumn('tasks', 'split_sessions')) {
            Schema::table('tasks', function (Blueprint $table) {
                $table->boolean('split_sessions')->default(false);
            });
        }
        if (DB::connection()->getDriverName() === 'pgsql') {
            $invalid = DB::selectOne('select 1 as x from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = ? and not i.indisvalid', [self::INDEX]);
            if ($invalid) {
                DB::statement('DROP INDEX IF EXISTS "'.self::INDEX.'"');
            }
            DB::statement('CREATE INDEX CONCURRENTLY IF NOT EXISTS "'.self::INDEX.'" ON "calendar_events" ("user_id", "task_id", "ends_at")');

            return;
        }
        if (! Schema::hasIndex('calendar_events', self::INDEX)) {
            Schema::table('calendar_events', fn (Blueprint $table) => $table->index(['user_id', 'task_id', 'ends_at'], self::INDEX));
        }
    }

    public function down(): void
    {
        if (DB::connection()->getDriverName() === 'pgsql') {
            DB::statement('DROP INDEX CONCURRENTLY IF EXISTS "'.self::INDEX.'"');
        } elseif (Schema::hasIndex('calendar_events', self::INDEX)) {
            Schema::table('calendar_events', fn (Blueprint $table) => $table->dropIndex(self::INDEX));
        }
        if (Schema::hasColumn('tasks', 'split_sessions')) {
            Schema::table('tasks', fn (Blueprint $table) => $table->dropColumn('split_sessions'));
        }
    }
};
