<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Changes suggested by the assistant. Nothing in here touches user data until the user approves specific actions.
     */
    public function up(): void
    {
        Schema::create('assistant_proposals', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('kind', 30);
            $table->string('provider', 30);
            $table->string('status', 20)->default('pending');
            $table->text('summary');
            $table->json('explanation');
            $table->json('actions');
            $table->json('results')->nullable();
            $table->timestampTz('expires_at');
            $table->timestampTz('applied_at')->nullable();
            $table->timestampsTz();
            $table->index(['user_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('assistant_proposals');
    }
};
