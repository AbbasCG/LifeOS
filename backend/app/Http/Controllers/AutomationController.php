<?php

namespace App\Http\Controllers;

use App\Models\AutomationRule;
use App\Models\AutomationRun;
use App\Models\Project;
use App\Services\AuditLogger;
use App\Services\AutomationEngine;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class AutomationController extends Controller
{
    public function __construct(private AutomationEngine $engine, private AuditLogger $audit) {}

    public function index(Request $request): JsonResponse
    {
        $rules = AutomationRule::where('user_id', $request->user()->id)->orderBy('created_at')->get();
        $failures = AutomationRun::where('user_id', $request->user()->id)->where('status', 'failed')->selectRaw('automation_rule_id, count(*) as total')->groupBy('automation_rule_id')->pluck('total', 'automation_rule_id');

        return response()->json([
            'rules' => $rules->map(fn (AutomationRule $r) => $this->present($r) + ['failed_runs' => (int) ($failures[$r->id] ?? 0)]),
            'catalogue' => AutomationEngine::CATALOGUE,
            'templates' => AutomationEngine::templates(),
            'limit' => AutomationEngine::MAX_RULES,
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validated($request);
        if (AutomationRule::where('user_id', $request->user()->id)->count() >= AutomationEngine::MAX_RULES) {
            throw ValidationException::withMessages(['rules' => ['You have reached the maximum number of automations.']]);
        }
        $rule = AutomationRule::create($data + ['user_id' => $request->user()->id]);
        $this->audit->log($request->user(), 'automation_changed', $request, ['rule' => $rule->id, 'change' => 'created']);

        return response()->json($this->present($rule), 201);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $rule = AutomationRule::where('user_id', $request->user()->id)->findOrFail($id);
        $data = $this->validated($request, $rule);
        $rule->update($data);
        $this->audit->log($request->user(), 'automation_changed', $request, ['rule' => $rule->id, 'change' => array_key_exists('enabled', $data) && count($data) === 1 ? ($data['enabled'] ? 'enabled' : 'disabled') : 'updated']);

        return response()->json($this->present($rule));
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        $rule = AutomationRule::where('user_id', $request->user()->id)->findOrFail($id);
        $rule->delete();
        $this->audit->log($request->user(), 'automation_changed', $request, ['rule' => $id, 'change' => 'deleted']);

        return response()->json(['message' => 'Automation deleted.']);
    }

    public function runs(Request $request, int $id): JsonResponse
    {
        $rule = AutomationRule::where('user_id', $request->user()->id)->findOrFail($id);

        return response()->json($rule->runs()->latest()->latest('id')->paginate(20)->through(fn (AutomationRun $run) => [
            'id' => $run->id, 'status' => $run->status, 'subject' => $run->subject, 'message' => $run->message, 'error' => $run->error, 'attempts' => $run->attempts, 'created_at' => $run->created_at->toIso8601String(), 'updated_at' => $run->updated_at->toIso8601String(),
        ]));
    }

    public function preview(Request $request): JsonResponse
    {
        $data = $this->validated($request);

        return response()->json(['matches' => $this->engine->preview($request->user(), $data['trigger'], $data['action'], $data['conditions'] ?? [])]);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, ?AutomationRule $rule = null): array
    {
        $data = $request->validate(AutomationEngine::validationRules($rule !== null));
        $trigger = $data['trigger'] ?? $rule?->trigger;
        $action = $data['action'] ?? $rule?->action;
        AutomationEngine::assertCompatible((string) $trigger, (string) $action);
        if (! empty($data['conditions']['project_id']) && ! Project::where('user_id', $request->user()->id)->whereKey($data['conditions']['project_id'])->exists()) {
            throw ValidationException::withMessages(['conditions.project_id' => ['Choose one of your projects.']]);
        }
        if (array_key_exists('conditions', $data)) {
            $data['conditions'] = array_filter($data['conditions'] ?? [], fn ($v) => $v !== null);
        }

        return $data;
    }

    /**
     * @return array<string, mixed>
     */
    private function present(AutomationRule $rule): array
    {
        return ['id' => $rule->id, 'name' => $rule->name, 'trigger' => $rule->trigger, 'conditions' => (object) ($rule->conditions ?? []), 'action' => $rule->action, 'action_config' => (object) ($rule->action_config ?? []), 'enabled' => (bool) $rule->enabled, 'run_count' => $rule->run_count, 'last_run_at' => $rule->last_run_at?->toIso8601String(), 'created_at' => $rule->created_at?->toIso8601String()];
    }
}
