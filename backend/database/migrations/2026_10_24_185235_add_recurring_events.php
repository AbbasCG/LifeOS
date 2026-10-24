<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive only. A recurring event is a single row with a rule; occurrences are expanded on demand.
     * Per-occurrence edits and cancellations live in calendar_event_exceptions, keyed by the original start.
     */
    public function up(): void
    {
        Schema::table('calendar_events', function (Blueprint $t) {
            $t->json('recurrence')->nullable()->after('kind');
            $t->string('timezone', 64)->nullable()->after('recurrence');
            $t->date('recurrence_until')->nullable()->after('timezone');
            $t->unsignedSmallInteger('remind_minutes')->nullable()->after('recurrence_until');
            $t->index(['user_id', 'recurrence_until']);
        });
        Schema::create('calendar_event_exceptions', function (Blueprint $t) {
            $t->id();
            $t->foreignId('calendar_event_id')->constrained()->cascadeOnDelete();
            $t->timestampTz('original_start');
            $t->boolean('cancelled')->default(false);
            $t->string('title')->nullable();
            $t->text('description')->nullable();
            $t->timestampTz('starts_at')->nullable();
            $t->timestampTz('ends_at')->nullable();
            $t->string('kind')->nullable();
            $t->timestamps();
            $t->unique(['calendar_event_id', 'original_start']);
            $t->index(['starts_at', 'ends_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('calendar_event_exceptions');
        Schema::table('calendar_events', function (Blueprint $t) {
            $t->dropIndex(['user_id', 'recurrence_until']);
            $t->dropColumn(['recurrence', 'timezone', 'recurrence_until', 'remind_minutes']);
        });
    }
};
