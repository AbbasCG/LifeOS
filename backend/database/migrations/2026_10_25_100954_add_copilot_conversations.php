<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * V10 conversational Copilot. Additive and reversible: conversations and their messages, and an optional link from a
 * Copilot proposal to the conversation that produced it.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conversations', function (Blueprint $t) {
            $t->uuid('id')->primary();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('title', 120);
            $t->string('language', 2)->default('en');
            $t->timestamp('last_message_at');
            $t->timestamps();
            $t->index(['user_id', 'last_message_at']);
        });
        Schema::create('conversation_messages', function (Blueprint $t) {
            $t->id();
            $t->uuid('conversation_id');
            $t->foreign('conversation_id')->references('id')->on('conversations')->cascadeOnDelete();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('role', 10);
            // Client-generated id of a user message: a retried request returns the stored answer instead of running twice.
            $t->string('client_id', 64)->nullable();
            $t->text('content');
            $t->string('intent', 40)->nullable();
            $t->string('provider', 40)->nullable();
            $t->json('payload')->nullable();
            $t->timestamp('created_at')->nullable();
            $t->unique(['user_id', 'client_id']);
            $t->index(['conversation_id', 'id']);
        });
        Schema::table('assistant_proposals', function (Blueprint $t) {
            $t->uuid('conversation_id')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('assistant_proposals', function (Blueprint $t) {
            $t->dropIndex(['conversation_id']);
            $t->dropColumn('conversation_id');
        });
        Schema::dropIfExists('conversation_messages');
        Schema::dropIfExists('conversations');
    }
};
