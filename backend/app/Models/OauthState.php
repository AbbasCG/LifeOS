<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One pending OAuth authorization. The state is stored only as a hash; the PKCE verifier is encrypted.
 */
class OauthState extends Model
{
    protected $table = 'oauth_states';

    protected $guarded = ['id'];

    protected $hidden = ['state_hash', 'verifier'];

    protected function casts(): array
    {
        return ['verifier' => 'encrypted', 'expires_at' => 'immutable_datetime', 'consumed_at' => 'immutable_datetime'];
    }
}
