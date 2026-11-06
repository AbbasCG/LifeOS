<?php

namespace App\Console\Commands;

use App\Models\FocusSession;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Read-only: shows whether this database stores moments an offset away from the real time (a PostgreSQL server in a zone other than UTC did
 * before the connection was pinned to UTC). Nothing is written, changed or deleted.
 */
class CheckDatabaseTime extends Command
{
    protected $signature = 'lifeos:check-database-time';

    protected $description = 'Report the database time zone and whether older focus sessions were stored with a time offset (read-only)';

    public function handle(): int
    {
        $driver = DB::getDriverName();
        $this->line("Database: {$driver} ".(string) config('database.connections.'.config('database.default').'.database'));
        $this->line('App time zone: '.config('app.timezone'));
        if ($driver === 'pgsql') {
            $this->line('Database connection time zone: '.DB::selectOne('show time zone')->TimeZone.' (configured: '.var_export(config('database.connections.pgsql.timezone'), true).')');
        }

        // started_at is `timestamp with time zone`, created_at has no zone: they were written at the same moment, so their difference is the offset.
        $drift = FocusSession::query()->where('kind', '!=', 'manual')->whereNotNull('started_at')->get(['started_at', 'created_at'])
            ->map(fn (FocusSession $s) => (int) $s->created_at->diffInSeconds($s->started_at, false))
            ->filter(fn (int $seconds) => abs($seconds) <= 14 * 3600);
        $shifted = $drift->filter(fn (int $seconds) => abs($seconds) >= 900);
        $this->line("Focus sessions checked: {$drift->count()}; stored with a time offset: {$shifted->count()}".($shifted->isNotEmpty() ? ' (typically '.round($shifted->median() / 3600, 2).' h)' : ''));
        if ($shifted->isNotEmpty()) {
            $this->warn('Those older sessions have timestamps shifted by that offset. They are left untouched; new sessions are stored correctly.');
        }

        return self::SUCCESS;
    }
}
