<?php

namespace App\Http\Controllers;

use App\Services\AssistantService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AssistantController extends Controller
{
    public function respond(Request $request, AssistantService $assistant): JsonResponse
    {
        $data = $request->validate(['message' => 'required|string|max:4000', 'language' => 'required|in:en,ar']);
        try {
            return response()->json($assistant->respond($request->user(), $data['message'], $data['language']));
        } catch (\Throwable $e) {
            return response()->json(['message' => 'The assistant is unavailable. Your data has not been changed.'], 503);
        }
    }
}
