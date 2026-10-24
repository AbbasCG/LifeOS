<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

#[Fillable(['name', 'email', 'password'])]
#[Hidden(['password', 'remember_token'])]
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
        ];
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
}
