<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive: goal milestones ([{title, completed, due_at?}]), mirroring project milestones.
     */
    public function up(): void
    {
        Schema::table('goals', function (Blueprint $table) {
            $table->json('milestones')->nullable()->after('due_at');
        });
    }

    public function down(): void
    {
        Schema::table('goals', function (Blueprint $table) {
            $table->dropColumn('milestones');
        });
    }
};
