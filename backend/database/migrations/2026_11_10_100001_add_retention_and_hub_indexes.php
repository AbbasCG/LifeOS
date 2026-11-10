<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Indexes for the retention prune and the Connected Accounts hub. Purely additive.
 *
 *  - sync_runs(started_at): the daily prune scans by age.
 *  - sync_runs(calendar_account_id, trigger, id): "latest outbound run of an account".
 *  - oauth_states(user_id), oauth_states(account_id), sync_conflicts(user_id): foreign keys, which PostgreSQL does not index by itself
 *    (cascading deletes of a user or an account otherwise scan these tables).
 *
 * On PostgreSQL the indexes are built CONCURRENTLY (no write lock on sync_runs while it builds), which cannot run inside a transaction, hence
 * $withinTransaction = false. An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS would silently keep, so an invalid one is
 * dropped first and the migration can simply be run again. Other drivers (SQLite in tests) use ordinary indexes, guarded by Schema::hasIndex.
 */
return new class extends Migration
{
    public $withinTransaction = false;

    /** @var array<string, array{0: string, 1: list<string>}> index name => table, columns */
    private const INDEXES = [
        'sync_runs_started_at_index' => ['sync_runs', ['started_at']],
        'sync_runs_account_trigger_id_index' => ['sync_runs', ['calendar_account_id', 'trigger', 'id']],
        'oauth_states_user_id_index' => ['oauth_states', ['user_id']],
        'oauth_states_account_id_index' => ['oauth_states', ['account_id']],
        'sync_conflicts_user_id_index' => ['sync_conflicts', ['user_id']],
    ];

    public function up(): void
    {
        $pgsql = DB::connection()->getDriverName() === 'pgsql';
        foreach (self::INDEXES as $name => [$table, $columns]) {
            if (! Schema::hasTable($table) || ! Schema::hasColumns($table, $columns)) {
                continue;
            }
            if ($pgsql) {
                $invalid = DB::selectOne('select 1 as x from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = ? and not i.indisvalid', [$name]);
                if ($invalid) {
                    DB::statement('DROP INDEX IF EXISTS "'.$name.'"');
                }
                DB::statement('CREATE INDEX CONCURRENTLY IF NOT EXISTS "'.$name.'" ON "'.$table.'" ("'.implode('", "', $columns).'")');

                continue;
            }
            if (! Schema::hasIndex($table, $name)) {
                Schema::table($table, fn ($t) => $t->index($columns, $name));
            }
        }
    }

    public function down(): void
    {
        foreach (self::INDEXES as $name => [$table, $columns]) {
            if (! Schema::hasTable($table)) {
                continue;
            }
            if (DB::connection()->getDriverName() === 'pgsql') {
                DB::statement('DROP INDEX CONCURRENTLY IF EXISTS "'.$name.'"');
            } elseif (Schema::hasIndex($table, $name)) {
                Schema::table($table, fn ($t) => $t->dropIndex($name));
            }
        }
    }
};
