<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A receiving address for signed inbound webhooks. Its secret is shown once at creation and stored encrypted.
 */
class WebhookEndpoint extends Model
{
    protected $guarded = ['id'];

    protected $hidden = ['secret', 'previous_secret'];

    protected function casts(): array
    {
        return [
            'secret' => 'encrypted', 'previous_secret' => 'encrypted', 'enabled' => 'boolean',
            'previous_secret_expires_at' => 'immutable_datetime', 'last_delivery_at' => 'immutable_datetime',
        ];
    }

    /** @return HasMany<WebhookDelivery, $this> */
    public function deliveries(): HasMany
    {
        return $this->hasMany(WebhookDelivery::class);
    }
}
