<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Optional, self-reported daily check-ins (one per user per local date). Every field is optional.
     */
    public function up(): void
    {
        Schema::create('daily_checkins', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->date('date');
            $table->unsignedTinyInteger('energy')->nullable();
            $table->unsignedTinyInteger('mood')->nullable();
            $table->unsignedTinyInteger('stress')->nullable();
            $table->unsignedTinyInteger('workload')->nullable();
            $table->unsignedSmallInteger('sleep_minutes')->nullable();
            $table->text('reflection')->nullable();
            $table->timestampsTz();
            $table->unique(['user_id', 'date']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('daily_checkins');
    }
};
