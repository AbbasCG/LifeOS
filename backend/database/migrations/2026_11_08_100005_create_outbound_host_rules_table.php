<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Explicit, administrator-managed exceptions to the outbound-request policy (default deny for private networks), for
 * custom integrations with systems that live on a private network. Loopback and link-local addresses are never allowed.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('outbound_host_rules', function (Blueprint $table) {
            $table->id();
            $table->string('host', 255);
            $table->unsignedSmallInteger('port')->default(443);
            $table->boolean('allow_private')->default(false);
            $table->string('note', 255)->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->unique(['host', 'port']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('outbound_host_rules');
    }
};
