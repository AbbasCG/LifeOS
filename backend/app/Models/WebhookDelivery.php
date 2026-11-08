<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One accepted webhook delivery. (endpoint, delivery_id) is unique, which makes redelivery idempotent even under a race.
 */
class WebhookDelivery extends Model
{
    public $timestamps = false;

    protected $guarded = ['id'];

    protected $hidden = ['payload'];

    protected function casts(): array
    {
        return ['payload' => 'encrypted', 'received_at' => 'immutable_datetime', 'processed_at' => 'immutable_datetime'];
    }

    /** @return BelongsTo<WebhookEndpoint, $this> */
    public function endpoint(): BelongsTo
    {
        return $this->belongsTo(WebhookEndpoint::class, 'webhook_endpoint_id');
    }
}
