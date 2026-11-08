<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Application-level OAuth client credentials for each provider, set once by a LifeOS administrator. The secret is
 * encrypted with the application key and never returned by the API. Environment values remain the fallback.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('integration_app_credentials', function (Blueprint $table) {
            $table->id();
            $table->string('provider_key', 40)->unique();
            $table->string('client_id', 255)->nullable();
            $table->text('client_secret')->nullable();
            $table->string('redirect_uri', 255)->nullable();
            $table->boolean('enabled')->default(true);
            $table->foreignId('set_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('rotated_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('integration_app_credentials');
    }
};
