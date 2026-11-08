<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Server-side OAuth authorization state: bound to one user and one provider, single use, short lived. The state itself
 * is stored only as a SHA-256 hash and the PKCE verifier encrypted, so a database read does not allow completing a flow.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('oauth_states', function (Blueprint $table) {
            $table->id();
            $table->char('state_hash', 64)->unique();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('provider', 40);
            $table->text('verifier');
            $table->string('return_to', 255)->nullable();
            $table->timestamp('expires_at')->index();
            $table->timestamp('consumed_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('oauth_states');
    }
};
