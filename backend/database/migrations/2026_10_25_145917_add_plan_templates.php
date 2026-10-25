<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * V13 week-plan templates. Additive and reversible: a template is a named list of blocks by weekday and local time,
 * saved from a Copilot proposal and turned into a new pending proposal when used.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('plan_templates', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->string('name', 80);
            $t->json('blocks');
            $t->timestamps();
            $t->index(['user_id', 'updated_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('plan_templates');
    }
};
