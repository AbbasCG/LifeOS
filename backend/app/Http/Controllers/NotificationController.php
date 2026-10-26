<?php

namespace App\Http\Controllers;

use App\Models\InboxNotification;
use App\Services\QuickActions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NotificationController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $query = InboxNotification::where('user_id', $request->user()->id);
        if ($request->boolean('unread')) {
            $query->whereNull('read_at');
        }
        $page = $query->latest()->latest('id')->paginate(30);
        $language = $request->user()->preferences()['language'] ?? 'en';
        $page->getCollection()->each(fn (InboxNotification $n) => $n->setAttribute('actions', QuickActions::for($n, $language)));

        return response()->json($page->toArray() + ['unread_count' => $this->unreadCount($request)]);
    }

    public function unread(Request $request): JsonResponse
    {
        return response()->json(['unread_count' => $this->unreadCount($request)]);
    }

    public function read(Request $request, int $id): JsonResponse
    {
        $notification = InboxNotification::where('user_id', $request->user()->id)->findOrFail($id);
        $notification->read_at ??= now();
        $notification->save();

        return response()->json(['message' => 'Read.', 'unread_count' => $this->unreadCount($request)]);
    }

    public function readAll(Request $request): JsonResponse
    {
        InboxNotification::where('user_id', $request->user()->id)->whereNull('read_at')->update(['read_at' => now()]);

        return response()->json(['message' => 'All read.', 'unread_count' => 0]);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        InboxNotification::where('user_id', $request->user()->id)->findOrFail($id)->delete();

        return response()->json(['message' => 'Deleted.', 'unread_count' => $this->unreadCount($request)]);
    }

    private function unreadCount(Request $request): int
    {
        return InboxNotification::where('user_id', $request->user()->id)->whereNull('read_at')->count();
    }
}
