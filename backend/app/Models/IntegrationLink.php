<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One external item (an EMC ticket first) linked to the LifeOS task created for it. See docs/EMC_INTEGRATION.md.
 * Written only by the integration (never mass-assigned from a request).
 */
class IntegrationLink extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return [
            'version' => 'integer', 'remote_due_at' => 'immutable_datetime', 'remote_due_all_day' => 'boolean',
            'closed_by_sync' => 'boolean', 'synced_at' => 'immutable_datetime',
        ];
    }

    /** @return BelongsTo<Task, $this> */
    public function task(): BelongsTo
    {
        return $this->belongsTo(Task::class);
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
