<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One accepted webhook delivery. (endpoint, delivery_id) is unique, which makes redelivery idempotent even under a race.
 *
 * Status: accepted (queued) -> retrying (a handler failed, another attempt is due at next_attempt_at) -> processed | ignored | failed. A failed
 * delivery keeps its encrypted payload until it is pruned, so it can be processed again (lifeos:webhooks:retry or a redelivery by the sender).
 */
class WebhookDelivery extends Model
{
    public $timestamps = false;

    protected $guarded = ['id'];

    protected $hidden = ['payload'];

    protected function casts(): array
    {
        return ['payload' => 'encrypted', 'received_at' => 'immutable_datetime', 'processed_at' => 'immutable_datetime', 'next_attempt_at' => 'immutable_datetime', 'attempts' => 'integer'];
    }

    /** @return BelongsTo<WebhookEndpoint, $this> */
    public function endpoint(): BelongsTo
    {
        return $this->belongsTo(WebhookEndpoint::class, 'webhook_endpoint_id');
    }
}
