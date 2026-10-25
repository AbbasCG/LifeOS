<?php

namespace App\Http\Controllers;

use App\Models\Task;
use App\Services\WeeklyIntelligence;
use App\Services\WeeklyReviewService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class ReviewController extends Controller
{
    public function show(Request $request, string $week, WeeklyReviewService $reviews, WeeklyIntelligence $weekly): JsonResponse
    {
        $start = $reviews->weekStart($request->user(), $week);
        $review = $reviews->build($request->user(), $start);

        return response()->json($review + ['intelligence' => $weekly->build($request->user(), $start, $review)]);
    }

    public function save(Request $request, string $week, WeeklyReviewService $reviews): JsonResponse
    {
        $start = $reviews->weekStart($request->user(), $week);
        $reviews->save($request->user(), $start, $this->validated($request));

        return response()->json($reviews->build($request->user(), $start));
    }

    public function complete(Request $request, string $week, WeeklyReviewService $reviews): JsonResponse
    {
        $start = $reviews->weekStart($request->user(), $week);
        $result = $reviews->complete($request->user(), $start, $this->validated($request));

        return response()->json($reviews->build($request->user(), $start) + $result);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request): array
    {
        $owned = Rule::exists('tasks', 'id')->where('user_id', $request->user()->id);
        $data = $request->validate([
            'reflection' => 'sometimes|array:wins,challenges,lessons,rating',
            'reflection.wins' => 'nullable|string|max:4000',
            'reflection.challenges' => 'nullable|string|max:4000',
            'reflection.lessons' => 'nullable|string|max:4000',
            'reflection.rating' => 'nullable|integer|min:1|max:5',
            'decisions' => 'sometimes|array|max:100',
            'decisions.*' => 'in:done,carry,drop',
            'priorities' => 'sometimes|array|max:7',
            'priorities.*' => ['integer', 'distinct', $owned],
        ]);
        $taskIds = array_keys($data['decisions'] ?? []);
        $valid = collect($taskIds)->every(fn ($id) => ctype_digit((string) $id))
            && Task::where('user_id', $request->user()->id)->whereIn('id', $taskIds)->count() === count($taskIds);
        if (! $valid) {
            throw ValidationException::withMessages(['decisions' => ['Decisions may only reference your own tasks.']]);
        }

        return $data;
    }
}
