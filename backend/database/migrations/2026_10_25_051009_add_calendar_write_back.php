<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Opt-in write-back to connected calendars: which calendar an account may add events to, and the copies LifeOS added
 * (the only external events LifeOS may ever change or remove). Additive and reversible.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('calendar_accounts', function (Blueprint $t) {
            $t->timestamp('write_granted_at')->nullable();
            $t->string('write_calendar_id', 512)->nullable();
            $t->string('write_calendar_name', 200)->nullable();
        });
        Schema::create('calendar_write_links', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('calendar_account_id')->constrained()->cascadeOnDelete();
            // Kept when the LifeOS event is deleted, so the copy can still be found and removed on request.
            $t->foreignId('calendar_event_id')->nullable()->constrained()->nullOnDelete();
            $t->string('calendar_id', 512);
            $t->string('external_id', 1024);
            $t->string('etag', 512)->nullable();
            $t->string('title', 200);
            $t->timestamp('starts_at');
            $t->timestamp('ends_at');
            $t->timestamps();
            $t->unique(['calendar_account_id', 'calendar_event_id']);
            $t->index(['user_id', 'calendar_event_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('calendar_write_links');
        Schema::table('calendar_accounts', function (Blueprint $t) {
            $t->dropColumn(['write_granted_at', 'write_calendar_id', 'write_calendar_name']);
        });
    }
};
