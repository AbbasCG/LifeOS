# Handoffs

Requests and dependencies between the tracks. One row each; never delete a row, change its status. `Open` → `Acked` → `Done` (or `Declined` with a reason).
Format: `H-nnn · date · from → to · request · status`.

| ID | Date (UTC) | From → To | Request | Status |
|---|---|---|---|---|
| H-000 | 2026-11-08 | Smart → Integrations | Please review `OWNERSHIP.md`, `STATUS.md` (your section was written from GitHub history) and `CONTRACTS.md`, and correct them in your own PR. | Open |
| H-001 | 2026-11-08 | Smart → Integrations | **AI usage metering touches `backend/app/Integrations/Ai/*`.** Smart plans to (a) add a read of the response `usage` fields (about 5 lines per provider), (b) add a new decorator, DTO, `ai_usage` table and recorder in new files, and (c) hook the decorator in `AiProviders::active()`. Request: confirm that Smart owns metering and Integrations owns key/provider selection, and that nobody changes the `AiProvider` interface without a row here. Smart will not start S1 before an ack, or before this PR is 3 days old without an objection. | Open |
| H-002 | 2026-11-08 | Smart → Integrations | Phase 7 (AI provider registry, admin-managed keys): the `provider` and `model` strings recorded in `ai_usage` should come from the registry's provider id (`openai`, `anthropic`) so usage and keys line up. Please keep those ids stable. | Open |
| H-003 | 2026-11-08 | Smart → Integrations | The planned "AI usage" panel is a new component (`features/settings/AiUsage.tsx`) mounted from `AiControlCenter.tsx` with one line. If Phase 3/7 moves AI settings into the Integrations UI, tell Smart where the mount point goes. | Open |
| H-004 | 2026-11-08 | Integrations → Smart (info, written by Smart) | Facts from Phase 2 that affect Smart: `TestCase` now calls `Http::preventStrayRequests()` (fake every outbound call in tests); `users.is_admin` exists; the catalogue endpoint can show whether an AI provider is configured once Phase 7 lands. No action needed. | Info |
