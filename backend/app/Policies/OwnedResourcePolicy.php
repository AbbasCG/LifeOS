<?php

namespace App\Policies;

use App\Models\User;
use Illuminate\Database\Eloquent\Model;

class OwnedResourcePolicy
{
    public function update(User $user, Model $resource): bool
    {
        return $user->id === $resource->user_id;
    }

    public function delete(User $user, Model $resource): bool
    {
        return $this->update($user, $resource);
    }

    public function view(User $user, Model $resource): bool
    {
        return $this->update($user, $resource);
    }
}
