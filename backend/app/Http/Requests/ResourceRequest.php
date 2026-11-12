<?php

namespace App\Http\Requests;

use App\Models\Task;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class ResourceRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user() !== null;
    }

    public function rules(): array
    {
        $required = $this->isMethod('POST') ? 'required' : 'sometimes';
        $owned = fn (string $table) => Rule::exists($table, 'id')->where('user_id', $this->user()->id);
        $common = ['title' => [$required, 'string', 'max:200'], 'description' => ['nullable', 'string', 'max:10000']];

        return $common + match ($this->route('resource')) {
            'tasks' => ['client_id' => $this->isMethod('POST') ? ['nullable', 'uuid'] : ['prohibited'], 'status' => ['sometimes', Rule::in(['inbox', 'todo', 'in_progress', 'completed', 'cancelled'])], 'priority' => ['sometimes', Rule::in(['low', 'medium', 'high', 'urgent'])], 'category_id' => ['nullable', $owned('categories')], 'project_id' => ['nullable', $owned('projects')], 'goal_id' => ['nullable', $owned('goals')], 'due_at' => ['nullable', 'date'], 'due_date' => ['nullable', 'date_format:Y-m-d', 'after_or_equal:1970-01-01', 'before:2100-01-01', 'prohibits:due_at', Rule::requiredIf(fn () => filter_var($this->input('due_all_day'), FILTER_VALIDATE_BOOLEAN))], 'due_all_day' => ['sometimes', 'boolean', fn ($attribute, $value, $fail) => ! filter_var($value, FILTER_VALIDATE_BOOLEAN) && $this->filled('due_date') ? $fail('due_all_day cannot be false when due_date is sent.') : null], 'remind_at' => ['nullable', 'date'], 'estimated_minutes' => ['sometimes', 'integer', 'min:5', 'max:10080'], 'recurrence' => ['nullable', Rule::in(['daily', 'weekly'])], 'subtasks' => ['nullable', 'array', 'max:50'], 'subtasks.*.title' => ['required', 'string', 'max:200'], 'subtasks.*.completed' => ['required', 'boolean'], 'tags' => ['nullable', 'array', 'max:20'], 'tags.*' => ['string', 'max:40'], 'notes' => ['nullable', 'string', 'max:10000']],
            'projects' => ['color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'status' => ['sometimes', Rule::in(['active', 'paused', 'completed'])], 'due_at' => ['nullable', 'date'], 'milestones' => ['nullable', 'array', 'max:50'], 'milestones.*.title' => ['required', 'string', 'max:200'], 'milestones.*.completed' => ['required', 'boolean']],
            'goals' => ['target' => ['sometimes', 'integer', 'min:1', 'max:1000000'], 'progress' => ['sometimes', 'integer', 'min:0', 'max:1000000'], 'due_at' => ['nullable', 'date'], 'color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'milestones' => ['nullable', 'array', 'max:50'], 'milestones.*.title' => ['required', 'string', 'max:200'], 'milestones.*.completed' => ['required', 'boolean']],
            'habits' => ['recurrence' => ['sometimes', Rule::in(['daily', 'weekly'])], 'routine' => ['nullable', 'string', 'max:100'], 'remind_time' => ['nullable', 'date_format:H:i']],
            'categories' => ['color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'area' => ['nullable', Rule::in(['work', 'study', 'personal'])]],
            default => [],
        };
    }

    /**
     * Datetime fields are handed to the model as UTC instants. Eloquent formats a string like "2026-02-12T10:30:00+01:00" for the database without
     * converting its offset, which would silently store 10:30 UTC (an hour off); Z and +00:00 happened to work. A date-only value stays the start
     * of that day in the app timezone (UTC), exactly as before.
     */
    public function validated($key = null, $default = null): mixed
    {
        $data = parent::validated();
        foreach (['due_at', 'remind_at'] as $field) {
            if (isset($data[$field]) && is_string($data[$field])) {
                $data[$field] = CarbonImmutable::parse($data[$field])->utc();
            }
        }

        // Tasks: due_date (YYYY-MM-DD) is the one way to set a date-only deadline; it becomes the end of that day in the account timezone with
        // due_all_day = true. Sending due_at (or null) sets a timed deadline and clears the flag. due_all_day on its own can only turn it off.
        if ($this->route('resource') === 'tasks') {
            if (array_key_exists('due_date', $data)) {
                $date = $data['due_date'];
                $data['due_at'] = $date ? Task::endOfDay($date, $this->user()->timezone()) : null;
                $data['due_all_day'] = $date !== null;
            } elseif (array_key_exists('due_at', $data)) {
                $data['due_all_day'] = false;
            }
            unset($data['due_date']);
        }

        return $key === null ? $data : data_get($data, $key, $default);
    }
}
