<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Connected external calendars (read-only) and the commitments imported from them.
     * Tokens are encrypted by the CalendarAccount model and never leave the server.
     */
    public function up(): void
    {
        Schema::create('calendar_accounts', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('provider', 20);
            $t->string('external_account_id');
            $t->string('email')->nullable();
            $t->string('display_name')->nullable();
            $t->text('access_token');
            $t->text('refresh_token')->nullable();
            $t->timestampTz('token_expires_at')->nullable();
            $t->text('scopes')->nullable();
            $t->string('status', 20)->default('active');
            $t->timestampTz('last_synced_at')->nullable();
            $t->string('last_error', 500)->nullable();
            $t->unsignedInteger('events_count')->default(0);
            $t->timestamps();
            $t->unique(['user_id', 'provider', 'external_account_id']);
            $t->index(['status', 'last_synced_at']);
        });
        Schema::create('external_events', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->foreignId('calendar_account_id')->constrained()->cascadeOnDelete();
            $t->string('external_id', 512);
            $t->string('calendar_id', 512)->nullable();
            $t->string('title', 500);
            $t->timestampTz('starts_at');
            $t->timestampTz('ends_at');
            $t->boolean('all_day')->default(false);
            $t->string('show_as', 20)->default('busy');
            $t->timestamps();
            $t->unique(['calendar_account_id', 'external_id']);
            $t->index(['user_id', 'starts_at', 'ends_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('external_events');
        Schema::dropIfExists('calendar_accounts');
    }
};
