<?php

use App\Http\Controllers\AssistantController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\FocusController;
use App\Http\Controllers\PlanningController;
use App\Http\Controllers\WorkspaceController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::get('/', fn () => response()->json(['application' => 'LifeOS', 'status' => 'ok']));
Route::prefix('api')->middleware('throttle:120,1')->group(function (): void {
    Route::post('register', [AuthController::class, 'register'])->middleware('throttle:6,1');
    Route::post('login', [AuthController::class, 'login'])->middleware('throttle:6,1');
    Route::post('forgot-password', [AuthController::class, 'forgot'])->middleware('throttle:3,1');
    Route::post('reset-password', [AuthController::class, 'reset'])->middleware('throttle:6,1');
    Route::middleware('auth:sanctum')->group(function (): void {
        Route::post('assistant', [AssistantController::class, 'respond'])->middleware('throttle:10,1');
        Route::get('user', fn (Request $r) => response()->json($r->user()));
        Route::post('logout', [AuthController::class, 'logout']);
        Route::patch('profile', [AuthController::class, 'profile']);
        Route::get('sessions', [AuthController::class, 'sessions']);
        Route::delete('sessions', [AuthController::class, 'revokeSessions']);
        Route::delete('account', [AuthController::class, 'destroy']);
        Route::get('settings', [WorkspaceController::class, 'settings']);
        Route::put('settings', [WorkspaceController::class, 'saveSettings']);
        Route::get('overview', [WorkspaceController::class, 'overview']);
        Route::get('export', [WorkspaceController::class, 'export']);
        Route::get('notifications', [WorkspaceController::class, 'notifications']);
        Route::patch('notifications/{id}', [WorkspaceController::class, 'readNotification']);
        Route::put('habits/{id}/entry', [WorkspaceController::class, 'habitEntry']);
        Route::get('focus-sessions', [FocusController::class, 'index']);
        Route::post('focus-sessions', [FocusController::class, 'store']);
        Route::patch('focus-sessions/{id}', [FocusController::class, 'update']);
        Route::post('plans', [PlanningController::class, 'generate']);
        Route::post('plans/{id}/accept', [PlanningController::class, 'accept']);
        Route::post('plans/{id}/reject', [PlanningController::class, 'reject']);
        Route::get('{resource}', [WorkspaceController::class, 'index'])->whereIn('resource', array_keys(WorkspaceController::MODELS));
        Route::post('{resource}', [WorkspaceController::class, 'store'])->whereIn('resource', array_keys(WorkspaceController::MODELS));
        Route::get('{resource}/{id}', [WorkspaceController::class, 'show'])->whereIn('resource', array_keys(WorkspaceController::MODELS));
        Route::patch('{resource}/{id}', [WorkspaceController::class, 'update'])->whereIn('resource', array_keys(WorkspaceController::MODELS));
        Route::delete('{resource}/{id}', [WorkspaceController::class, 'destroy'])->whereIn('resource',array_keys(WorkspaceController::MODELS));
    });
});
