<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Additive: which time boundary a category's tasks belong to (work | study | personal). Null means work.
     */
    public function up(): void
    {
        Schema::table('categories', function (Blueprint $table) {
            $table->string('area', 20)->nullable()->after('color');
        });
    }

    public function down(): void
    {
        Schema::table('categories', function (Blueprint $table) {
            $table->dropColumn('area');
        });
    }
};
