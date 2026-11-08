<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Application-level OAuth client credentials for one provider. The secret is encrypted at rest and hidden from every
 * serialisation; it is only read by CredentialVault when a provider needs to talk to its authorization server.
 */
class AppCredential extends Model
{
    protected $table = 'integration_app_credentials';

    protected $guarded = ['id'];

    protected $hidden = ['client_secret'];

    protected function casts(): array
    {
        return ['client_secret' => 'encrypted', 'enabled' => 'boolean', 'rotated_at' => 'immutable_datetime', 'connections_blocked_at' => 'immutable_datetime'];
    }

    /** @return BelongsTo<User, $this> */
    public function setBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'set_by');
    }
}
