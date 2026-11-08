<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('webhook_endpoints', function (Blueprint $table) {
            $table->id();
            $table->uuid('public_id')->unique();
            $table->string('provider_key', 40);
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->string('name', 120);
            $table->text('secret');
            $table->text('previous_secret')->nullable();
            $table->timestamp('previous_secret_expires_at')->nullable();
            $table->boolean('enabled')->default(true);
            $table->timestamp('last_delivery_at')->nullable();
            $table->timestamps();
        });

        Schema::create('webhook_deliveries', function (Blueprint $table) {
            $table->id();
            $table->foreignId('webhook_endpoint_id')->constrained()->cascadeOnDelete();
            $table->string('delivery_id', 120);
            $table->char('payload_sha256', 64);
            $table->unsignedInteger('size');
            $table->text('payload')->nullable();
            $table->string('status', 20)->default('accepted');
            $table->timestamp('received_at')->useCurrent();
            $table->timestamp('processed_at')->nullable();
            $table->unique(['webhook_endpoint_id', 'delivery_id']);
            $table->index('received_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('webhook_deliveries');
        Schema::dropIfExists('webhook_endpoints');
    }
};
