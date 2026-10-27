<?php

namespace App\Http\Requests;

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
            'tasks' => ['client_id' => $this->isMethod('POST') ? ['nullable', 'uuid'] : ['prohibited'], 'status' => ['sometimes', Rule::in(['inbox', 'todo', 'in_progress', 'completed', 'cancelled'])], 'priority' => ['sometimes', Rule::in(['low', 'medium', 'high', 'urgent'])], 'category_id' => ['nullable', $owned('categories')], 'project_id' => ['nullable', $owned('projects')], 'goal_id' => ['nullable', $owned('goals')], 'due_at' => ['nullable', 'date'], 'remind_at' => ['nullable', 'date'], 'estimated_minutes' => ['sometimes', 'integer', 'min:5', 'max:10080'], 'recurrence' => ['nullable', Rule::in(['daily', 'weekly'])], 'subtasks' => ['nullable', 'array', 'max:50'], 'subtasks.*.title' => ['required', 'string', 'max:200'], 'subtasks.*.completed' => ['required', 'boolean'], 'tags' => ['nullable', 'array', 'max:20'], 'tags.*' => ['string', 'max:40'], 'notes' => ['nullable', 'string', 'max:10000']],
            'projects' => ['color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'status' => ['sometimes', Rule::in(['active', 'paused', 'completed'])], 'due_at' => ['nullable', 'date'], 'milestones' => ['nullable', 'array', 'max:50'], 'milestones.*.title' => ['required', 'string', 'max:200'], 'milestones.*.completed' => ['required', 'boolean']],
            'goals' => ['target' => ['sometimes', 'integer', 'min:1', 'max:1000000'], 'progress' => ['sometimes', 'integer', 'min:0', 'max:1000000'], 'due_at' => ['nullable', 'date'], 'color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'milestones' => ['nullable', 'array', 'max:50'], 'milestones.*.title' => ['required', 'string', 'max:200'], 'milestones.*.completed' => ['required', 'boolean']],
            'habits' => ['recurrence' => ['sometimes', Rule::in(['daily', 'weekly'])], 'routine' => ['nullable', 'string', 'max:100'], 'remind_time' => ['nullable', 'date_format:H:i']],
            'categories' => ['color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'area' => ['nullable', Rule::in(['work', 'study', 'personal'])]],
            default => [],
        };
    }
}
