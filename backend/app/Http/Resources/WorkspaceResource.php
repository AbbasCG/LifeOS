<?php

namespace App\Http\Resources;

use App\Models\Task;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class WorkspaceResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $data = $this->resource->toArray();
        unset($data['user_id']);
        if ($this->resource instanceof Task) {
            // The calendar date of a date-only deadline in the account timezone (null for a timed or missing deadline). Read once per request.
            $tz = $request->attributes->get('account_timezone') ?? tap($request->user()?->timezone() ?? 'UTC', fn ($v) => $request->attributes->set('account_timezone', $v));
            $data['due_all_day'] = (bool) $this->resource->due_all_day;
            $data['due_date'] = $this->resource->dueDate($tz);
        }

        return $data;
    }
}
