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
