# Status

Each track edits **only its own section**. One line per update: date (UTC) · branch · commit · what. Newest first. Do not rewrite the other track's section;
if it is wrong, add a row to `HANDOFFS.md`.

## Repository snapshot (written 2026-11-08 01:30 UTC by Smart Experience)

| Item | Value |
|---|---|
| `main` | `be6d81b` (merge of PR #61) |
| CI on `main` | success |
| Last deploy | #31 `be6d81b` success (verified backup 129,850 bytes / 38 tables, 5 additive migrations, health checks ok, no approval step) |
| Ruleset `LifeOS — Main Protection` | active: PR required, 5 checks (`Laravel (pgsql)`, `Laravel (sqlite)`, `React`, `Browser (Playwright)`, `Deploy tooling`), branch up to date, no force-push/deletion, no bypass actors |
| `AUTO_DEPLOY` | on: a merge to `main` deploys after CI is green on the merge commit |

## Smart Experience

| Date (UTC) | Branch | Commit / PR | Update |
|---|---|---|---|
| 2026-11-08 | `claude/smart-release-management-p7` | PR (P7, second round) | Staged rollout (admin / internal / general) enforced on the server for every discovery answer and the notification, test accounts, "why it is not shown", eligible counts. One additive migration (`2026_11_08_210001`). Workflows and deploy scripts untouched. |
| 2026-11-08 | `claude/smart-discovery-center-p6` | PR (P6, second round) | Advanced Discovery Center: suggestions with reasons, filters, New/Tried marks, details dialog. Frontend only; no content, endpoint or release changed. |
| 2026-11-08 | `claude/smart-auto-release` | PR (automatic updates) | Releases register and approve themselves after a healthy deploy (`DISCOVERY_AUTO_ACTIVATE` and new `DISCOVERY_AUTO_APPROVE` default on), every release notifies and reading it clears the notification, a count on "What's new" in the menu, second release (Discover). See H-018. |
| 2026-11-08 | `claude/smart-discovery-stats` | PR (P8 of Product Experience 2.0) | `GET /api/admin/discovery/stats` (counts only: seen, dismissed, rated, tried, tours, tips) and a "How people received it" block on `/admin/releases`; a checklist before approving. Nothing new is stored. See H-017. |
| 2026-11-08 | `claude/smart-release-admin` | PR (P9 of Product Experience 2.0) | Screen `/admin/releases` for administrators: status, the exact ar/nl/en text, approve (fingerprint + "I read it" + password prompt) and withdraw; `preview` in the admin list; menu entry for administrators only. No server setting changes. See H-016. |
| 2026-11-08 | `claude/smart-release-tools` | PR (P7 of Product Experience 2.0) | `scripts/release-notes-draft.sh` (draft a release file from merged PRs; cannot ship by accident), optional deploy hook `DEPLOY_REGISTER_RELEASES=1` (register shipped notes as drafts right after a healthy deploy; default off), loader guard for draft markers, tests, docs. See H-015. |
| 2026-11-08 | `claude/smart-discovery-center` | PR (P6 of Product Experience 2.0) | Discovery Center at `/discover`: `GET /api/discovery/features`, `DiscoverPage` (categories, search, Try now, tour start/replay, reasons), a menu entry in group More, tests. Shows only features of approved releases. |
| 2026-11-08 | `claude/smart-whats-new-content` | PR (first What's New content) | Release `2026-11-08-everyday-capture` (Quick Capture ar/nl/en with a one-step tour, Dutch, updates/New marks/tips, mobile polish, sign-out fix), `ShippedContentTest`, and the owner's activation steps in `docs/DISCOVERY.md`. Shown to nobody until `DISCOVERY_AUTO_ACTIVATE` is on and an administrator approves the fingerprint. |
| 2026-11-08 | `claude/smart-ci-hardening` | PR (CI/CD hardening, phase 2) | Dedicated PR that touches `.github/workflows/ci.yml`, `scripts/` and `docs/DEPLOYMENT.md` (see H-013): actionlint no longer depends on one download host (cache, `go install`, pip, retries; fails if none works), bad-workflow rejection tests, an axe helper for the What's New / hint / tour specs that waits for animations and reports every element, a written account of the CI gate and of `HEALTH_REQUIRE_UP=0`. No production setting changed. |
| 2026-11-08 06:39 | `claude/smart-nl-basic` | PR (Dutch as a chosen language) | `Language` is ar, en or nl; `useText(en, ar, nl?)` falls back to English where there is no Dutch text; Dutch accepted by settings, assistant and Copilot; AI replies in Dutch. Nothing else was translated. |
| 2026-11-08 06:48 | `claude/smart-whats-new-ui` | PR (P3 of Product Experience 2.0) | What's New sheet (`DiscoveryHost`, `WhatsNewSheet`), update history at `/updates`, "Try now" (opens the page; tours come in P5), `release` notification icon, sidebar entry. Still shows nothing until a release is approved and activation is on (H-009). |
| 2026-11-08 06:19 | `claude/smart-release-core` | PR (P2 of Product Experience 2.0) | Release core: content registry, release lifecycle (healthy deploy + administrator approval), feature gate, `/api/discovery`, notification category `updates`. Shows nothing yet; activation is off by default (H-009). See `docs/DISCOVERY.md`. |
| 2026-11-08 02:25 | `claude/smart-mobile-p2` | PR #64, merge `ebc7d3c` (head `5829e95`) | **S2 part 2 merged:** discard guard on sheets (`BottomSheet dirty`, task form, Quick Add), tab-list keyboard (`radioGroups`), Quick Add date tile as a radio. CI green (12/12); 160 Playwright cases passed locally. |
| 2026-11-08 02:00 | `claude/smart-mobile-p1` | PR #63, merge `4388a10` (head `3fef911`) | **S2 part 1 merged and deployed (#33 success):** dictated "next week" lights the date tile, priority tile contrast, focus rings, switch accessible name (H-005), 44 px targets. |
| 2026-11-08 01:30 | `claude/coordination-docs` | PR #62, merge `3c06419` | Coordination files. |
| 2026-11-08 00:20 | `claude/quick-capture-multilang` | PR #60, merge `e77fc1d` | Quick Capture reads day, time and length in English, Arabic and Dutch, with an "Understood:" preview. |

Next slices: **S1 `ai_usage`** — blocked on H-001 (needs the Integrations track's ack: it touches `backend/app/Integrations/Ai/*`). Owner's decisions: usage tracking only, no token cap. **S3 Quick Capture v2** — one `readIntent` for typed and dictated text (weekdays, "next week", "the Nth", priorities, the Arabic comma); no dependency on the Integrations track, not started.

## Integrations Hub  (initial entry written from GitHub history by Smart Experience — the Integrations session corrects it)

| Date | Branch | Commit / PR | Update |
|---|---|---|---|
| 2026-11-09 | `feature/integrations-sync-engine` | PR (Connected Accounts plan, PR 4 of 5; see H-022) | Sync direction (inbound / outbound / two-way / manual) and conflict policy (ask / keep the service's / keep LifeOS's / keep both) per connection, never beyond the person's permissions; outbound only updates copies LifeOS added (never creates or deletes by itself); open conflicts, dry run, pause, a proof-only sync summary. One additive migration. |
| 2026-11-09 | `feature/integrations-security-qa` | PR (Connected Accounts plan, PR 5 of 5; see H-023) | Security matrix tests (IDOR, administrator role, rate limits, no secrets), Dutch for all Hub texts, setup/security/go-live guide `docs/INTEGRATIONS_SETUP.md`. No migration. |
| 2026-11-09 | `feature/integrations-permissions` | PR (Connected Accounts plan, PR 3 of 5; see H-021) | Per-connection permissions (read, sync, import, export, create, update, delete) chosen in Manage permissions and enforced on the server before any write, scheduled sync or import; least privilege for new connections; older connections keep what they had but not Delete. One additive migration. |
| 2026-11-09 | `feature/integrations-oauth-connection` | PR (Connected Accounts plan, PR 2 of 5; see H-020) | OAuth state and PKCE on the server for connect, callback and the write consent; the callback checks that the provider is still set up and on; no setup details for ordinary people; clear outcome messages. One additive migration. |
| 2026-11-09 | `claude/integrations-provider-config` | PR (Connected Accounts plan, PR 1 of 5; written by the Smart session at the owner's request, see H-019) | Provider configuration screen for administrators (set up, rotate, switch off new connections, offline test, change log), `disabled` state, repair of an unreadable secret. One additive migration. |
| 2026-11-08 | `claude/integrations-core` | PR #61, merge `be6d81b` (head `e33beb8`) | Phase 2 merged and deployed: registry (14 manifests) + `GET /api/integrations/catalog`, credential vault and `users.is_admin` (`lifeos:make-admin`), OAuth state store, token-refresh lock, signed webhooks, outbound policy, log redaction. Existing connectors unchanged; the new state store is not yet wired into the connect routes. |

Planned by that track (per its Phase 1 report): Phase 3 Hub UI · Phase 4 Google/Microsoft onto the core · Phase 5 Todoist/GitHub/Notion/Trello/Telegram · Phase 6 custom systems · Phase 7 n8n and AI-provider registry · Phase 8 security review.
