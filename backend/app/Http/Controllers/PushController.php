<?php

namespace App\Http\Controllers;

use App\Integrations\Push\WebPush;
use App\Models\PushSubscription;
use App\Services\AuditLogger;
use App\Services\Notifier;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class PushController extends Controller
{
    public function __construct(private WebPush $push, private AuditLogger $audit) {}

    /**
     * Whether the server can send push, and the public VAPID key browsers need to subscribe.
     */
    public function config(Request $request): JsonResponse
    {
        return response()->json(['configured' => $this->push->isConfigured(), 'public_key' => $this->push->publicKey(), 'channels' => Notifier::channels($request->user()->preferences())]);
    }

    public function index(Request $request): JsonResponse
    {
        return response()->json(PushSubscription::where('user_id', $request->user()->id)->orderByDesc('created_at')->get()
            ->map(fn (PushSubscription $s) => ['id' => $s->id, 'device' => $s->user_agent, 'created_at' => $s->created_at->toIso8601String(), 'last_used_at' => $s->last_used_at?->toIso8601String()]));
    }

    public function store(Request $request): JsonResponse
    {
        if (! $this->push->isConfigured()) {
            throw ValidationException::withMessages(['push' => ['Push notifications are not configured on this server.']]);
        }
        $data = $request->validate([
            'endpoint' => 'required|string|max:2000|url:https',
            'keys' => 'required|array:p256dh,auth',
            'keys.p256dh' => ['required', 'string', 'max:200', 'regex:/^[A-Za-z0-9_-]+={0,2}$/'],
            'keys.auth' => ['required', 'string', 'max:100', 'regex:/^[A-Za-z0-9_-]+={0,2}$/'],
        ]);
        if (! WebPush::allowedEndpoint($data['endpoint'])) {
            throw ValidationException::withMessages(['endpoint' => ['This browser’s push service is not supported.']]);
        }
        $point = WebPush::base64UrlDecode(rtrim($data['keys']['p256dh'], '='));
        if (strlen($point) !== 65 || $point[0] !== "\x04" || strlen(WebPush::base64UrlDecode(rtrim($data['keys']['auth'], '='))) < 16) {
            throw ValidationException::withMessages(['keys' => ['Invalid subscription keys.']]);
        }
        $hash = hash('sha256', $data['endpoint']);
        $existing = PushSubscription::where('endpoint_hash', $hash)->first();
        if ($existing && $existing->user_id !== $request->user()->id) {
            $existing->delete();
        }
        if (PushSubscription::where('user_id', $request->user()->id)->where('endpoint_hash', '!=', $hash)->count() >= 10) {
            throw ValidationException::withMessages(['endpoint' => ['Too many devices. Remove one first.']]);
        }
        $subscription = PushSubscription::updateOrCreate(['endpoint_hash' => $hash], [
            'user_id' => $request->user()->id, 'endpoint' => $data['endpoint'], 'public_key' => rtrim($data['keys']['p256dh'], '='), 'auth_token' => rtrim($data['keys']['auth'], '='),
            'user_agent' => mb_substr((string) $request->userAgent(), 0, 255), 'failures' => 0,
        ]);
        if ($subscription->wasRecentlyCreated) {
            $this->audit->log($request->user(), 'push_subscribed', $request);
        }

        return response()->json(['id' => $subscription->id], $subscription->wasRecentlyCreated ? 201 : 200);
    }

    public function destroy(Request $request, int $id): JsonResponse
    {
        PushSubscription::where('user_id', $request->user()->id)->findOrFail($id)->delete();
        $this->audit->log($request->user(), 'push_unsubscribed', $request);

        return response()->json(['message' => 'This device will no longer receive push notifications.']);
    }

    /**
     * Remove the subscription for the browser that is unsubscribing, identified by its endpoint.
     */
    public function forget(Request $request): JsonResponse
    {
        $data = $request->validate(['endpoint' => 'required|string|max:2000']);
        $deleted = PushSubscription::where('user_id', $request->user()->id)->where('endpoint_hash', hash('sha256', $data['endpoint']))->delete();
        if ($deleted) {
            $this->audit->log($request->user(), 'push_unsubscribed', $request);
        }

        return response()->json(['message' => 'Unsubscribed.']);
    }

    public function test(Request $request, Notifier $notifier): JsonResponse
    {
        $ar = ($request->user()->preferences()['language'] ?? 'en') === 'ar';
        $notification = $notifier->send($request->user(), 'system', 'test:'.$request->user()->id.':'.now()->getTimestamp().':'.bin2hex(random_bytes(4)), $ar ? 'إشعار تجريبي من LifeOS' : 'Test notification from LifeOS', ['body' => $ar ? 'الإشعارات تعمل على هذا الجهاز.' : 'Notifications are working on this device.', 'link' => '/settings/notifications', 'force' => true]);

        return response()->json(['id' => $notification?->id, 'push_status' => $notification?->fresh()?->push_status]);
    }
}
