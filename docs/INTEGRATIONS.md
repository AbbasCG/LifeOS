# Integrations core (Phase 2)

The foundation for the Universal Integrations Hub: a provider registry, an encrypted credential vault, server-side OAuth state,
signed webhooks, an outbound-request policy and an administrator role. It is **backend only**; the gallery UI is Phase 3. The existing
connectors (Google, Outlook, Google Tasks, Microsoft To Do, Todoist, ICS) keep working unchanged and read their OAuth client from the
vault first and `.env` second.

Nothing here simulates a connection: a provider is "connected" only when the server holds a real account for it, and "ready" only when
its OAuth client has real credentials.

## Provider registry

`backend/resources/integrations/<id>.json` — one manifest per integration, validated by `ManifestRegistry` (a malformed manifest fails
tests and boot). Fields: `id`, `category`, `auth` (`oauth2_pkce | oauth2 | api_key | webhook | ics | custom`), `status`
(`available | planned`), bilingual `name` / `description`, `scopes` (with English and Arabic labels), `capabilities`, `multi_account`,
`requires_admin_setup`, optional `docs_url`. `available` providers must have a connector class; a test enforces that the two lists match.
`auth` is honest: Todoist is `oauth2` because Todoist offers no PKCE.

`GET /api/integrations/catalog` (signed-in users) returns every manifest with the real state:

| `state` | Meaning |
|---|---|
| `planned` | Not implemented yet; cannot be connected |
| `requires_setup` | Implemented, but no OAuth client credentials exist (ask an administrator) |
| `disconnected` | Ready, no account connected |
| `connected` | At least one account, none broken |
| `syncing` | A sync run started in the last 10 minutes is still running (a stuck run is not shown as syncing) |
| `error` | An account is revoked, under-scoped, failing or waiting out a rate limit (`detail`: `revoked`, `scope`, `waiting`, `failed`) |

The response contains each user's own accounts only, and never tokens or credentials.

The old `IntegrationController::PROVIDERS` and `ConnectedCatalog` lists are untouched; Phase 3 moves the UI to the catalog and Phase 4
retires them.

## Credential vault and administrators

Application-wide OAuth clients are set once by a LifeOS **administrator** instead of editing `.env`:

1. Make an account an administrator (operator, on the server): `php artisan lifeos:make-admin you@example.com`
   (`--revoke` removes it). The flag cannot be set through the API, registration or mass assignment, and the grant is audited.
2. The administrator turns on two-factor authentication in Security settings (required for changes; set
   `INTEGRATIONS_ADMIN_REQUIRES_2FA=false` only for a local development machine).
3. `PUT /api/admin/integrations/credentials/{provider}` with `client_id`, `client_secret` and optionally `redirect_uri`
   (needs a password confirmation within 15 minutes). `GET` lists the status per provider; `DELETE` removes the database record.

Rules:
- A complete database record (client id **and** secret) is used instead of the `services.*` environment values; the two sources are never
  mixed field by field. Without a record the environment values keep working exactly as before.
- The secret is encrypted with `APP_KEY` (`encrypted` cast), hidden from serialisation, **write-only** through the API, and audit entries
  record the provider and whether the secret changed — never the secret or the client id.
- `redirect_uri` must be this site's own https address ending in `/api/integrations/<provider>/callback`; it must also be registered
  with the provider exactly as typed.
- Only `available` providers that need setup can be configured (not feeds, not planned providers).

### Rotating `APP_KEY`
1. Put the new key in `APP_KEY` and the old one in `APP_PREVIOUS_KEYS` (Laravel reads with either).
2. `php artisan lifeos:integrations:reencrypt` re-encrypts app credentials, webhook secrets and payloads, pending OAuth verifiers and
   connected-account access/refresh tokens with the new key and reports anything it could not decrypt (left untouched).
3. Two-factor secrets and push-subscription keys are also `APP_KEY`-encrypted but are **not** covered by this command yet: keep the old
   key in `APP_PREVIOUS_KEYS` until they are handled. Losing `APP_KEY` makes every stored token and secret unreadable — back it up.

## OAuth state (`OAuthStateStore`)

Authorization state lives in the `oauth_states` table, not the browser session: a random state and PKCE verifier bound to one user and
one provider, stored as a SHA-256 hash and an encrypted verifier, valid for 10 minutes and consumable **once** by a single atomic
`UPDATE` (two concurrent callbacks cannot both win; another user, another provider, an expired or reused state yields nothing).
`return_to` keeps only same-site paths. `lifeos:integrations:prune` (daily) deletes old rows. The existing connect/callback routes still
use their session-based state until Phase 4 moves them onto this store; their callback now has an `integrations` rate limit.

`CalendarSyncService::freshToken()` now takes a per-account lock and re-reads the account before refreshing, so a queued sync and a manual
action can never refresh the same account twice (providers that rotate refresh tokens would otherwise invalidate one of them). A caller
that cannot get the lock within `integrations.refresh_lock_wait` seconds fails with a clear message instead of refreshing.

## Signed webhooks

`POST /api/webhooks/{publicId}` is public (no session, cookies or CSRF; authenticity comes from the signature). Per endpoint a secret
(`whsec_…`, shown once at creation, stored encrypted) is used with:

```
X-LifeOS-Timestamp: <unix seconds>
X-LifeOS-Delivery:  <unique id per event; reuse it when retrying>
X-LifeOS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw request body>" with the secret>
```

```bash
ts=$(date +%s); body='{"order":42}'
sig="sha256=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -sS -X POST "https://<host>/api/webhooks/<publicId>" -H "Content-Type: application/json" \
  -H "X-LifeOS-Timestamp: $ts" -H "X-LifeOS-Delivery: evt-$ts" -H "X-LifeOS-Signature: $sig" --data-raw "$body"
```

Behaviour: unknown or disabled endpoint → `404` (identical); body over 1 MB → `413`; any signature or timestamp problem → `401` with one
message (the cause is not revealed); a valid request without a well-formed delivery id → `400`; a repeated delivery id → `202`
`{"status":"duplicate"}` and no second processing (unique `(endpoint, delivery_id)`, safe under races); otherwise `202`, recorded, and
handed to `ProcessWebhookDelivery` on the queue. The timestamp must be within 5 minutes (limits replay). Rate limited per endpoint+IP and
per IP. After `WebhookEndpointService::rotate()` the previous secret keeps working for 24 hours. Connectors react by tagging a
`WebhookHandler` with `integrations.webhook_handlers`; deliveries nobody handles are recorded as `ignored`. Payloads are encrypted, removed
once handled and deleted after 7 days. Provider-specific schemes (e.g. GitHub's `X-Hub-Signature-256`) are added by connectors in Phase 5.

## Outbound requests (`OutboundHttpGuard`)

For addresses a person typed in (custom integrations, Phase 6): HTTPS only, no embedded credentials, port 443, public addresses only
(every DNS answer is checked and the connection is pinned to the checked address; redirects are not followed). A private-network system
(an internal ERP) is reachable only through an explicit `outbound_host_rules` row for that exact host and port with `allow_private`.
Loopback (this server's PostgreSQL, PHP-FPM…), link-local/metadata (169.254.0.0/16, fe80::/10), multicast and unspecified addresses are
**never** allowed, even with a rule. `PublicAddress` is shared with the calendar-feed fetcher.

## Logs and error text

`RedactSecretsProcessor` masks bearer/basic tokens, JWTs, token-like URL parameters and `access_token`, `refresh_token`, `client_secret`,
`code_verifier`, `api_key`, `password`… (in text, context and extra) on the file, daily, stderr, syslog and errorlog channels. Provider
error text stored for the user (`sync_runs.error`, `calendar_accounts.last_error`) is scrubbed the same way. Limit: exception messages
written by Laravel's own exception logging are not rewritten, so connectors must not put credentials in exception messages.

## Tests

`backend/tests/Feature/Integrations/*` (81 tests): manifests, OAuth state (RFC 7636 vector, replay, user/provider binding, expiry,
concurrency), vault (encryption at rest, source precedence, key rotation), administrator API (403/423/422 paths, no secret in any response
or audit entry), webhooks (signature, raw bytes, replay, timestamps, size, rotation, rate limit, no cookies/CSRF, handlers), outbound guard
(IPv4/IPv6, mapped addresses, rebinding via mixed answers, rules), catalogue states and per-user isolation, redaction, and the refresh lock.
`TestCase` now calls `Http::preventStrayRequests()`, so a test that forgets to fake an outbound call fails instead of reaching the network.
The suite passes on SQLite and on PostgreSQL 16 (client zone `Europe/Amsterdam`); the new migrations roll back and re-apply on PostgreSQL.

## Not in this phase
Hub UI (Phase 3); moving Google/Microsoft/Todoist onto the new state store and catalogue (Phase 4); GitHub, Notion, Trello, Telegram
(Phase 5); custom systems such as EMC and Tharaa and the administrator screens for outbound rules and webhook endpoints (Phase 6);
n8n bridge and AI-provider key management (Phase 7). The deployment needs no `.env`, Docker, n8n or PostgreSQL configuration change; the
five migrations are additive and run through the normal deploy (verified `pg_dump` first).

## Provider configuration screen (Connected Accounts master plan, PR 1 of 5)

Settings → Integrations shows, **to administrators only**, a *Provider configuration* panel (below the connected accounts). It is the screen for the vault described above, so an OAuth client no longer needs SSH or a `.env` edit.

What an administrator does, once per provider:
1. At the provider (Google Cloud, Microsoft Entra, Todoist), create the OAuth app. This is still required once; LifeOS cannot create it for you. The panel links to the provider's documentation.
2. In the panel, press *Set up*. Copy the **redirect address** it shows (generated from the site's own trusted address; it cannot be typed) and register it at the provider exactly as shown.
3. Paste the **client id** and **client secret**, save (a password confirmation may be asked; two-factor must be on). The secret is stored encrypted, is not shown again, and the page clears it from memory as soon as it was sent.
4. Press *Test configuration*. It checks, **without contacting the provider**, that a client id exists, the secret can be read with the current key, the redirect address is the one this site expects, and a sign-in address can be built. Only a real sign-in proves that the provider accepts the client.

Other controls:
- **Switch off new connections** (`PATCH /api/admin/integrations/credentials/{provider}/enabled`): people can no longer start a connection to that provider; the catalogue shows it as `disabled`. Accounts that are already connected keep syncing and refreshing, and nothing is deleted. It also works for a provider configured only through `.env` (a row with no client id or secret is created; the environment values are never copied). Saving credentials again does not switch it back on; removing the saved client keeps it off.
- **Remove saved client**: deletes the database record (the environment values, if any, are used again).
- **Rotating a secret**: create the new secret at the provider, paste it, save and test, then delete the old one at the provider. Connected accounts keep working throughout (their tokens are separate from the client secret).
- **Secret cannot be read** (the server's `APP_KEY` changed without `APP_PREVIOUS_KEYS`): the panel says so and asks for the secret again; entering it repairs the record. Before this change an unreadable secret made the administrator list fail with a server error.
- **Change log**: the latest changes (who, what, which provider, when) from the audit log: `integration_credentials_set`, `integration_credentials_removed`, `integration_provider_enabled`, `integration_provider_disabled`, `integration_config_tested`. An entry never holds a secret, a client id, an address or an IP.

Security rules kept: administrator + two-factor for every change (`EnsureIntegrationAdmin`), a recent password confirmation for save, remove and the switch, the secret is `encrypted`-cast, hidden from serialisation and never in a response, a log or the browser's storage; the compatibility path (`.env`) is read as before and never copied into the database; `APP_KEY` and the other system secrets are not touched.

New migration `2026_11_09_100001` adds `integration_app_credentials.connections_blocked_at` (nullable; every existing row stays unblocked).

## Connecting an account (Connected Accounts plan, PR 2 of 5)

A person connects Google, Outlook, Google Tasks, Microsoft To Do or Todoist without any key: Settings → Integrations → *Connect*, sign in on the provider's own page, allow the access, and come back to LifeOS with the account shown as connected. The OAuth client (client id and secret) comes from the **Provider configuration** screen, or from the server's `.env` as before (the saved client wins when both exist; they are never mixed).

How the flow is protected:
- **State and PKCE on the server.** `connect` creates a random 256-bit state and a PKCE verifier through `OAuthStateStore` (table `oauth_states`: the state only as a SHA-256 hash, the verifier encrypted, bound to one person and one provider, valid 10 minutes). Nothing about the flow lives in the browser session any more. The callback accepts a state **once**, for that person and that provider only; a forged, expired, replayed, foreign-person or foreign-provider state ends in `?error=state` and connects nothing. (A wrong-person or wrong-provider attempt does not spend the state, so it cannot be used to cancel somebody else's sign-in.)
- **The callback only ever redirects to the app** (`app.frontend_url` + `/settings/integrations`), whatever the query holds; no address from the request is followed.
- **Outcome codes** shown to the person: `connected=<provider>`, `error=state` (expired or already used), `error=denied` (cancelled at the provider; the state is spent), `error=exchange` (the provider refused the code), `error=scope` (the read permission was not granted), `error=not_configured` and `error=provider_disabled` (an administrator changed the provider while the person was signing in), `error=write_scope` / `error=write_account` (the separate permission to add events). None of them carries a provider message, a code or a token.
- **Tokens** are encrypted at rest (`encrypted` cast), never returned by any endpoint, and removed on *Disconnect*, which also revokes them at the provider where one exists.
- **Reconnect** updates the same account (matched by the provider's account id), so it never duplicates; it clears a revoked or error state.
- A person who is **signed out** while on the provider's page gets the app's 401 (the route stays behind sign-in on purpose: `RouteSecurityTest` forbids redirects for guests on protected routes). Signing in again and pressing *Connect* once more fixes it; the unused state expires by itself.
- An ordinary person never sees a variable name, a redirect address or a key. For a provider that is not set up they are told to ask an administrator; administrators are pointed to *Provider configuration*.

What differs between providers (checked in the code, not assumed):

| | Google Calendar / Google Tasks | Outlook / Microsoft To Do | Todoist |
|---|---|---|---|
| PKCE | yes (S256) | yes (S256) | **no** (Todoist offers none; the state still protects the flow, and no challenge or verifier is sent) |
| Refresh tokens | yes (`access_type=offline`) | yes | **none**: a Todoist token does not expire; if it is refused the person reconnects |
| Revoke on disconnect | yes (`oauth2.googleapis.com/revoke`) | no endpoint exists for delegated tokens; our copy is deleted | no endpoint; the person can also remove LifeOS under Todoist's own settings |
| Redirect address | `/api/integrations/google/callback` and `/api/integrations/google_tasks/callback` | `/api/integrations/outlook/callback` and `/api/integrations/microsoft_todo/callback` | `/api/integrations/todoist/callback` |

**Calendar and Tasks are separate providers.** With `.env`, Google Calendar and Google Tasks read the same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Outlook and To Do the same `MICROSOFT_*`). On the Provider configuration screen each has its own record, so the administrator enters the client for each (the same Google OAuth app may be used for both: register both redirect addresses in it). Nothing is shared silently.

Migration `2026_11_09_110001` adds a nullable `account_id` to `oauth_states` (the second consent that adds the write permission names the account it is for). It is additive; pending rows are unaffected.

## What LifeOS may do with a connection (Connected Accounts plan, PR 3 of 5)

Four things are kept apart, because mixing them would let a screen promise more than it can keep:

1. **The provider's OAuth scopes** — what the token the service issued can do. LifeOS cannot narrow it. A broad write scope at Google still permits deletion *at Google*.
2. **The provider's capabilities** — what LifeOS has an adapter for. A task service (Google Tasks, Microsoft To Do, Todoist) and a calendar feed (ICS) have no write adapter at all, so no write is ever offered for them.
3. **The person's choice for this connection** — `calendar_accounts.permissions`, set in *Manage permissions*. **This is what LifeOS enforces on the server**: before anything is sent to a provider, and before background syncing or importing, `ConnectionPermissions::authorize()` is called. A disabled button in the browser is never the protection.
4. **Sync policies** (direction, conflicts) — PR 4.

So "Delete is off" means *LifeOS will not call the delete API*, not that the token cannot delete. The screen says this in words.

### Permission matrix (from the code)

| Service | Read | Sync | Import | Send changes (export) | Create | Update | Delete |
|---|---|---|---|---|---|---|---|
| Google Calendar | yes | yes | n/a | yes¹ | yes¹ | yes¹ | yes¹ |
| Outlook Calendar | yes | yes | n/a | yes¹ | yes¹ | yes¹ | yes¹ |
| Google Tasks | yes | yes | yes | **no** | **no** | **no** | **no** |
| Microsoft To Do | yes | yes | yes | **no** | **no** | **no** | **no** |
| Todoist | yes | yes | yes | **no** | **no** | **no** | **no** |
| Calendar feed (ICS) | yes | yes | n/a | **no** | **no** | **no** | **no** |

¹ Only where the server has adding events switched on (`LIFEOS_CALENDAR_WRITE`) **and** the provider gave the separate write access. Without that access the choice is saved but not effective, and the screen offers *Allow at the service* (the existing second consent), which is the re-consent step. "Import" means copying an item into LifeOS (tasks); calendar events are shown as busy time, never copied.

### Meaning of each permission

- **read** — always on; to stop it, disconnect.
- **sync** — background syncing by the scheduler. Off = the scheduler and any already-queued scheduled run skip the account; *Sync now* still works.
- **import** — copy an imported task into LifeOS.
- **export** — send anything to the service at all. It is on exactly when at least one of create, update or delete is.
- **create / update / delete** — add, change or remove **only events LifeOS itself added** (the copies tracked in `calendar_write_links`); each change still needs a preview and a confirmation. The check runs at the preview and again at the confirmation, so a choice changed in between is respected.

Presets: *Read only* (read, sync, import) · *Read + Create* · *Read + Create + Update* · *Full access including Delete*, plus *Custom*. A preset is offered only if the service can do it.

### Defaults and older connections

- A **new** connection starts with the least: read, sync, import. Reconnecting keeps the person's choice.
- A connection made **before** this had no choice stored (`permissions` is NULL). It keeps what it could do — reading, syncing, importing and, where the person had allowed adding events, adding and changing those copies — and is **not given Delete**. Removing a copy now needs Delete to be turned on first. Scheduled sync is unchanged.
- Turning Delete **on** needs its own confirmation in the screen **and** `confirm_delete: true` in the request (the server refuses without it); changing permissions needs a recent password confirmation.

### API

`GET|PUT /api/integrations/accounts/{id}/permissions` — `PUT` takes `{preset}` or `{permissions: [...]}` (not both) and optionally `confirm_delete`. `GET /api/integrations` shows per provider `capabilities` and `presets`, and per account `permissions` (`granted`, `effective`, `blocked` with the reason, `preset`, `legacy`). A refused operation answers `403 {code: "permission_denied", operation, reason}` with reason `not_allowed`, `unsupported`, `reconsent_required` or `revoked`. Changes are audited (`integration_permissions_changed`: provider, account, operation names only) and so are refusals (`integration_permission_denied`).

Migration `2026_11_09_120001`: nullable `calendar_accounts.permissions` (JSON) and `permissions_changed_at`; nothing is rewritten.
