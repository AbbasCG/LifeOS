# Contracts shared between the tracks

A contract is something one track provides and the other may rely on. Changing it needs a row in `HANDOFFS.md` first. "Verified" means checked against the code on `main` at the date shown.

## Provided by Integrations Hub (Smart Experience may rely on these)

| Contract | Shape | Verified |
|---|---|---|
| Catalogue | `GET /api/integrations/catalog` → `data.providers[]` (`id`, `category`, `auth`, `status`, bilingual `name`/`description`, `scopes`, `state`, `setup_ready`, `accounts[]`) and `data.can_manage`. `state` ∈ `planned, requires_setup, disconnected, connected, syncing, error`. Never contains tokens. | 2026-11-08 |
| Administrator | `users.is_admin` (boolean, in the user JSON), Gate `manage-integrations`. Set only by `php artisan lifeos:make-admin`. | 2026-11-08 |
| External calendar and task data | Read through `CalendarService` sources (`ExternalEvent`, `ExternalTask`); stable external ids; `calendar_accounts` keeps one row per account. Smart Scheduling reads only. | 2026-11-08 |
| Signed webhooks | `POST /api/webhooks/{publicId}` with `X-LifeOS-Timestamp`, `X-LifeOS-Delivery`, `X-LifeOS-Signature: sha256=HMAC("<ts>.<raw body>")`. Handlers are tagged `integrations.webhook_handlers`. | 2026-11-08 |
| Outbound HTTP | `OutboundHttpGuard::check($url)` before any request to a user- or admin-supplied address. | 2026-11-08 |

## Provided by Smart Experience (Integrations Hub may rely on these)

| Contract | Shape | Status |
|---|---|---|
| Quick Capture reader | `readCapture(text, now)` in `frontend/src/lib/capture.ts` returns day offset (0–2), clock time and length; planned `readIntent()` (S3) will be a superset. | Existing |
| AI call metering | **Proposed (H-001):** one `ai_usage` row per external-model call (`user_id, feature, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, status, latency_ms, fallback_used, created_at`; no prompts or content). Recorded by a decorator around the active `AiProvider`; read through `GET /api/intelligence/usage`. | Proposed |
| AI provider interface | `AiProvider::json(system, input, schema): array` stays array-returning. Proposed addition (single owner): `usage(): ?AiUsage` accessor on the provider after a call. | Proposed |

## Conventions both tracks follow

- UI strings: `useText()(en, ar)` pairs in the component; manifests carry `en`/`ar` fields. Arabic and RTL are required for every new screen.
- Every outbound HTTP call in a test must be faked (`Http::preventStrayRequests()` is on in `TestCase`).
- New audit actions are appended to `AuditLogger::ACTIONS`; metadata never contains secrets, tokens, prompts or message content.
- Migrations are additive and reversible; PostgreSQL 16 and SQLite must both pass.
