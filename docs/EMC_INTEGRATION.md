# EMC → LifeOS ticket sync (phase 1)

**Status: draft contract, to be confirmed with the EMC team before the endpoint is created in production.** Nothing here is active until an
administrator creates an EMC endpoint (`php artisan lifeos:emc:create-endpoint`) and EMC starts sending.

Goal: when an EMC ticket is assigned to a LifeOS user, LifeOS creates **one** task for it in the user's Inbox, with no start time and no
calendar session. EMC keeps the ticket's title, priority and deadline in sync; everything the person does in LifeOS (notes, description,
subtasks, estimate, schedule, focus sessions, their own edits) is never overwritten. Closing or unassigning the ticket never deletes the task.

Phase 1 is **one EMC account per LifeOS user** (one endpoint), designed so more accounts can be added later (see "Accounts").

## 1. Transport and signature

`POST https://<lifeos-host>/api/webhooks/{publicId}` — one endpoint per LifeOS user and EMC account, created by an administrator.

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-LifeOS-Timestamp` | Unix seconds when the request is sent. Refused if more than **300 s** from LifeOS's clock (both sides must run NTP). |
| `X-LifeOS-Delivery` | The event's `event_id` (identical to the body field). Reuse it, unchanged, when retrying the same event. |
| `X-LifeOS-Signature` | `sha256=` + lowercase hex **HMAC-SHA256** of `"<timestamp>.<raw request body>"` with the endpoint secret (`whsec_…`). |

- The HMAC covers the **exact bytes sent**; never re-encode the JSON after signing.
- The endpoint is created with `require_event_id = true`: the body **must** carry a top-level `event_id` equal to `X-LifeOS-Delivery`,
  so the (unsigned) header cannot be changed to replay a captured request.
- Secret rotation: LifeOS can rotate the secret; the old one keeps working for 24 hours.
- Body limit 1 MB. Rate limit 120 requests/minute per endpoint and address.

Example (sender side):

```bash
ts=$(date +%s)
body='{"schema_version":1,"event_id":"evt_01J9…","type":"ticket.assigned",…}'
sig="sha256=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$EMC_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -sS -X POST "https://<host>/api/webhooks/<publicId>" -H "Content-Type: application/json" \
  -H "X-LifeOS-Timestamp: $ts" -H "X-LifeOS-Delivery: evt_01J9…" -H "X-LifeOS-Signature: $sig" --data-raw "$body"
```

### Responses

| Status | Meaning | What EMC should do |
|---|---|---|
| `202 {"status":"accepted"}` | Recorded; processed asynchronously | Done |
| `202 {"status":"duplicate"}` | This `event_id` was already received | Done (do not resend) |
| `202 {"status":"requeued"}` | A previously failed delivery with the same bytes is processed again | Done |
| `400` | Missing or malformed `X-LifeOS-Delivery` / `event_id`, or they differ | Fix the request; do not retry as is |
| `401` | Bad signature or timestamp (one message for every cause) | Check clock and secret; retry with a new timestamp |
| `404` | Unknown or disabled endpoint | Stop; contact the LifeOS administrator |
| `413` / `429` / `5xx` | Too large / rate limited / server error | Retry later with backoff (same `event_id`, new timestamp and signature) |

A `202` means "received", not "applied": validation of the ticket data happens asynchronously. An invalid payload is recorded as `failed`
in LifeOS (`php artisan lifeos:webhooks:failed`) and is not retried.

## 2. Body (`schema_version` 1)

Every event carries a **full snapshot** of the ticket as EMC sees it now, so any later event repairs a lost or failed earlier one.

```json
{
  "schema_version": 1,
  "event_id": "evt_01J9ZK3Q7W",
  "type": "ticket.updated",
  "occurred_at": "2026-11-26T09:15:00Z",
  "ticket": {
    "external_id": "T-1042",
    "version": 7,
    "title": "Replace the meeting-room display",
    "priority": "high",
    "due_at": "2026-12-01T17:00:00+01:00",
    "due_date": null,
    "url": "https://emc.example.com/tickets/T-1042",
    "assignee_id": "emc-user-42"
  }
}
```

| Field | Rules |
|---|---|
| `schema_version` | Integer, must be `1`. |
| `event_id` | 1–120 chars `[A-Za-z0-9._:-]`, unique per event, equal to `X-LifeOS-Delivery`. |
| `type` | `ticket.assigned`, `ticket.updated`, `ticket.closed` or `ticket.unassigned`. |
| `occurred_at` | ISO 8601 instant with offset or `Z`. Informational. |
| `ticket.external_id` | 1–200 chars `[A-Za-z0-9._:/#-]`, stable for the life of the ticket. |
| `ticket.version` | Integer ≥ 1, **strictly increasing per ticket across all event types** (assignment changes included). |
| `ticket.title` | Required, 1–500 chars. Control characters become spaces; zero-width and text-direction characters are removed; LifeOS keeps the first 200. |
| `ticket.priority` | `low`, `normal`, `medium`, `high`, `urgent` or `critical` (case-insensitive). Mapped to LifeOS `low`, `medium`, `medium`, `high`, `urgent`, `urgent`; any other value becomes `medium`. |
| `ticket.due_at` | Optional. ISO 8601 instant **with offset or `Z`** (a timed deadline), or `null`. |
| `ticket.due_date` | Optional. `YYYY-MM-DD` (a deadline without a time: the end of that day in the user's LifeOS timezone), or `null`. Never together with `due_at`. Both null/absent = no deadline. |
| `ticket.url` | Optional. `https://` only, ≤ 1000 chars, default port (443) only, no user name or password, and the host must be listed in LifeOS's `EMC_ALLOWED_URL_HOSTS` (exact host, case-insensitive; subdomains are not included). Anything else, and every link while that list is empty, is dropped; the event still applies. |
| `ticket.assignee_id` | Optional, ≤ 200 chars. Recorded for diagnosis; not used for decisions in phase 1 (the endpoint already identifies the LifeOS user). |

Unknown extra fields are ignored. A payload that breaks these rules is refused as a whole (no partial apply).

## 3. What LifeOS does

The endpoint belongs to exactly one LifeOS user and one EMC account key. Each ticket has one row in `integration_links`
(unique per user, source, account and `external_id`) and at most one task.

**Ordering:** an event is applied only if `ticket.version` is **greater** than the last applied version for that ticket; otherwise it is
ignored as stale (the delivery is still recorded). Events for one user are applied one at a time (user row lock), and each delivery
is applied atomically with its own status.

| Event | No task yet | Task exists |
|---|---|---|
| `ticket.assigned` | Creates the task (see below) | Applies the snapshot; if LifeOS itself completed it on an earlier `ticket.closed`, puts it back in the **Inbox** (a completion the person made is never undone) |
| `ticket.updated` | Creates the task only the first time LifeOS ever sees the ticket; if the person deleted the task, it is **not** recreated | Applies the snapshot; never reopens a completed task (the snapshot has no status, so an edit to a closed ticket must not bring it back) |
| `ticket.closed` | Records the state only | Completes the task (`completed`, `completed_at` now) unless it is already completed or cancelled. Calendar blocks and focus sessions stay. No next occurrence is created. |
| `ticket.unassigned` | Records the state only | Leaves the task as it is and, if it is still open, puts one notification in the person's LifeOS inbox; they decide whether to keep or cancel it |

**A new task:** title (≤ 200), mapped priority, deadline, status `inbox`, tag `emc`, `source_ref = emc:<account>:<external_id>`, description
"EMC ticket <external_id>: <url>" (written once, never updated). No `scheduled_start`/`scheduled_end`, no calendar session, no reminder.

**Applying a snapshot to an existing task (three-way merge):** for each of title, priority and deadline, LifeOS updates the task only
if the task still has the value EMC sent last time. If the person changed it in LifeOS, their value is kept (EMC's new value is still
recorded on the link). Notes, description, subtasks, tags, estimate, project/goal/category, schedule, reminders and focus sessions are
never touched. A deadline moved by EMC does not count as a postponement in LifeOS statistics.

**Deleting:** LifeOS never deletes a task because of EMC. If the person deletes the task, the link stays (without a task) so a later
`ticket.updated` does not bring it back; only a new `ticket.assigned` does.

## 4. Accounts (now and later)

- Phase 1: `php artisan lifeos:emc:create-endpoint <user email> [--account=default]` creates one endpoint for that user and account key,
  with `require_event_id = true`, and prints the URL and the secret **once**. It refuses a second EMC endpoint for the same user and
  account key, and it never runs without an explicit email.
- Later: another EMC account (another tenant, or the same user in two EMC instances) is another endpoint with another `--account`
  key; links and `source_ref` include the key, so tickets with the same `external_id` in two accounts never collide. A shared,
  organisation-level endpoint that maps EMC assignees to LifeOS users would map `assignee_id` → user in a new table; the link table and
  the handler do not change.

## 5. Operations

- Diagnose: `php artisan lifeos:webhooks:failed`; process again: `php artisan lifeos:webhooks:retry <id>` (see `INTEGRATIONS.md`).
- Temporary errors (database, lock timeout) are retried with backoff; an invalid payload fails at once.
- A delivery whose queued job was lost (queue outage, worker stopped) is queued again automatically once it is overdue by
  `stale_after_seconds` (1 hour): `lifeos:webhooks:retry --stuck` runs every 15 minutes. It is still applied once.
- Disable an endpoint: set `webhook_endpoints.enabled = false`. EMC then gets `404`, and deliveries it had already accepted are not applied
  (they end `failed` with "The endpoint is disabled.", payload kept, and can be retried once it is enabled again; until then
  `lifeos:webhooks:retry` refuses them). An event that is already being applied when the endpoint is disabled finishes.
- Before go-live set `EMC_ALLOWED_URL_HOSTS` to EMC's ticket host; without it tasks are created without the ticket link.
- Failures are logged and stored without ticket content (see `INTEGRATIONS.md`, "Retries").

## 6. Open points to confirm with EMC

1. Exact EMC priority values (the mapping above covers the common ones).
2. Whether EMC can guarantee a strictly increasing `version` per ticket, including assignment changes. If not, LifeOS needs another
   ordering key (e.g. a monotonic `updated_at` in microseconds) before go-live.
3. Whether `ticket.unassigned` is sent to the previous assignee's endpoint (required for that event to reach LifeOS).
4. Deadlines: whether EMC distinguishes date-only deadlines (`due_date`) from timed ones (`due_at`).
5. EMC's retry policy on `5xx`/timeouts (same `event_id`, new timestamp and signature, for how long).
