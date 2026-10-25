<?php

namespace App\Http\Controllers;

use App\Integrations\Calendar\ProviderException;
use App\Models\CalendarAccount;
use App\Models\CalendarWriteLink;
use App\Services\AuditLogger;
use App\Services\CalendarSyncService;
use App\Services\CalendarWriteService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Opt-in write-back: separate consent, an explicit calendar, then preview → confirm for every single change.
 */
class CalendarWriteController extends Controller
{
    public function __construct(private CalendarWriteService $writes, private AuditLogger $audit) {}

    /** Accounts that can receive events, and the copies LifeOS added. */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $accounts = CalendarAccount::where('user_id', $user->id)->whereIn('provider', ['google', 'outlook'])->get();

        return response()->json([
            'enabled' => $this->writes->featureEnabled(),
            'targets' => $accounts->filter(fn (CalendarAccount $a) => $this->writes->state($a)['enabled'])->map(fn (CalendarAccount $a) => [
                'id' => $a->id, 'provider' => $a->provider, 'email' => $a->email, 'calendar_name' => $a->write_calendar_name,
            ])->values(),
            'links' => CalendarWriteLink::with('event')->where('user_id', $user->id)->latest('id')->limit(500)->get()->map(fn (CalendarWriteLink $l) => $l->present())->values(),
        ]);
    }

    /** Start the separate consent that adds the write permission to an already connected account. */
    public function connect(Request $request, int $id): JsonResponse
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        $writer = $this->writes->writer($account);
        if (! $writer) {
            throw ValidationException::withMessages(['account' => ['Adding events is not available for this account on this server.']]);
        }
        if ($account->status === 'revoked') {
            throw ValidationException::withMessages(['account' => ['Reconnect this account first.']]);
        }
        $state = Str::random(40);
        $verifier = Str::random(96);
        $request->session()->put("oauth.{$state}", ['provider' => $account->provider, 'verifier' => $verifier, 'user_id' => $request->user()->id, 'expires' => now()->getTimestamp() + IntegrationController::STATE_TTL, 'write_account_id' => $account->id]);
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');

        return response()->json(['authorization_url' => $writer->writeAuthorizationUrl($state, $challenge, $account->email)]);
    }

    /** Calendars this account may add events to (after the write permission was granted). */
    public function calendars(Request $request, int $id): JsonResponse
    {
        $account = $this->granted($request, $id);
        try {
            return response()->json(['data' => $this->writes->writer($account)->writableCalendars(app(CalendarSyncService::class)->freshToken($account))]);
        } catch (ProviderException $e) {
            throw ValidationException::withMessages(['account' => [$e->getMessage()]]);
        }
    }

    /** Pick the calendar LifeOS may add events to, or turn adding off (calendar_id null). */
    public function choose(Request $request, int $id): JsonResponse
    {
        $account = $this->granted($request, $id);
        $data = $request->validate(['calendar_id' => 'present|nullable|string|max:512']);
        if ($data['calendar_id'] === null) {
            $account->forceFill(['write_calendar_id' => null, 'write_calendar_name' => null])->save();
            $this->audit->log($request->user(), 'calendar_write_disabled', $request, ['provider' => $account->provider, 'account_id' => $account->id]);
        } else {
            try {
                $calendars = collect($this->writes->writer($account)->writableCalendars(app(CalendarSyncService::class)->freshToken($account)));
            } catch (ProviderException $e) {
                throw ValidationException::withMessages(['account' => [$e->getMessage()]]);
            }
            $calendar = $calendars->firstWhere('id', $data['calendar_id']) ?? throw ValidationException::withMessages(['calendar_id' => ['Choose a calendar you can add events to.']]);
            $account->forceFill(['write_calendar_id' => $calendar['id'], 'write_calendar_name' => $calendar['name']])->save();
            $this->audit->log($request->user(), 'calendar_write_enabled', $request, ['provider' => $account->provider, 'account_id' => $account->id]);
        }

        return response()->json(['write' => $this->writes->state($account->fresh())]);
    }

    public function preview(Request $request): JsonResponse
    {
        $data = $request->validate([
            'op' => ['required', Rule::in(CalendarWriteService::OPS)],
            'account_id' => 'required|integer',
            'event_id' => 'nullable|integer',
            'link_id' => 'nullable|integer',
        ]);

        return response()->json($this->writes->preview($request->user(), $data));
    }

    public function confirm(Request $request): JsonResponse
    {
        $data = $request->validate(['token' => 'required|string|max:4000']);

        return response()->json($this->writes->confirm($request->user(), $data['token'], $request));
    }

    private function granted(Request $request, int $id): CalendarAccount
    {
        $account = CalendarAccount::where('user_id', $request->user()->id)->findOrFail($id);
        if (! $this->writes->writer($account) || $account->write_granted_at === null || $account->status === 'revoked') {
            throw ValidationException::withMessages(['account' => ['Allow LifeOS to add events to this account first.']]);
        }

        return $account;
    }
}
