<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Runtime state of a release whose content lives in resources/discovery/releases/<key>.json.
 */
class ProductRelease extends Model
{
    public const DRAFT = 'draft';

    public const APPROVED = 'approved';

    public const WITHDRAWN = 'withdrawn';

    public const LIVE = 'live';

    public const ABSENT = 'absent';

    /** Who may see an approved, live release: administrators only (a preview), administrators and test accounts, or everyone. */
    public const ROLLOUT_ADMIN = 'admin';

    public const ROLLOUT_INTERNAL = 'internal';

    public const ROLLOUT_GENERAL = 'general';

    public const ROLLOUTS = [self::ROLLOUT_ADMIN, self::ROLLOUT_INTERNAL, self::ROLLOUT_GENERAL];

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return [
            'revision' => 'integer',
            'reviewed_at' => 'immutable_datetime', 'published_at' => 'immutable_datetime', 'live_since' => 'immutable_datetime', 'absent_since' => 'immutable_datetime', 'last_confirmed_at' => 'immutable_datetime',
        ];
    }

    /** Shown to users only when an administrator approved it and a successful deploy confirmed it live. */
    public function isVisible(): bool
    {
        return $this->review_status === self::APPROVED && $this->deploy_status === self::LIVE;
    }
}
