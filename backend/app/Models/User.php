<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Illuminate\Support\Facades\DB;

#[Fillable(['name', 'email', 'password'])]
#[Hidden(['password', 'remember_token', 'two_factor_secret', 'two_factor_recovery_codes', 'two_factor_last_step'])]
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, Notifiable;

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_admin' => 'boolean',
            'two_factor_secret' => 'encrypted',
            'two_factor_recovery_codes' => 'encrypted:array',
            'two_factor_confirmed_at' => 'immutable_datetime',
        ];
    }

    /**
     * @var list<string>
     */
    protected $appends = ['two_factor_enabled'];

    /**
     * Whether two-factor authentication has been set up and confirmed.
     */
    public function getTwoFactorEnabledAttribute(): bool
    {
        return $this->two_factor_confirmed_at !== null;
    }

    /**
     * Stored workspace preferences, or an empty array when the user has not saved any.
     *
     * @return array<string, mixed>
     */
    public function preferences(): array
    {
        return UserSetting::where('user_id', $this->id)->first()?->preferences ?? [];
    }

    /**
     * The planning timezone, defaulting to UTC.
     */
    public function timezone(): string
    {
        return $this->preferences()['timezone'] ?? 'UTC';
    }

    /**
     * Lock the user's row to order work per user (the booking lock). Inside a transaction only.
     *
     * Lock order across the app: user row, proposal row, task rows (ascending id), then calendar rows. On PostgreSQL the lock is FOR NO KEY UPDATE,
     * not FOR UPDATE: every insert of a row with a foreign key to the user (tasks, calendar events, ...) takes FOR KEY SHARE on the user row, which
     * FOR UPDATE would conflict with. A path that holds a task lock and then inserts a task would then deadlock with a booking holding the user row
     * and waiting for that task. FOR NO KEY UPDATE still excludes every other holder of this lock, and never blocks those inserts.
     */
    public static function lockForOrdering(int $id): self
    {
        return static::whereKey($id)->lock(DB::getDriverName() === 'pgsql' ? 'for no key update' : true)->firstOrFail();
    }
}
