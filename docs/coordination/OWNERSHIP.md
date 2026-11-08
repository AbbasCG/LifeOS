# Ownership — who may change what

Two independent Claude Code sessions work in parallel on LifeOS. This file is the single place that says which one owns which area, so
neither duplicates or overwrites the other. Proposed by the Smart Experience session on 2026-11-08; the Integrations session confirms or
amends it in its own PR (see `HANDOFFS.md` H-000). Owner of the repository: Abbas (merges every PR by hand; `AUTO_DEPLOY` is on, so a merge to `main` deploys).

## Tracks

| Track | Branch prefix | Owns |
|---|---|---|
| **Smart Experience** | `claude/smart-*` | AI Daily Briefing · Quick Capture and Voice Capture · Smart Scheduling and Rescheduling · AI Brain and AI Usage · Productivity Analytics · Smart Projects and Knowledge · Mobile UX and RTL · Weekly Review · Product updates, Feature Discovery and Interactive Onboarding (What's New) |
| **Integrations Hub** | `claude/integrations-*` | Connector Core · OAuth (state, PKCE, refresh) · Provider Registry (manifests) · Credential Vault and administrators · Webhooks · Outbound HTTP policy · Integrations UI (catalogue, detail pages, admin screens) · custom systems (EMC, Tharaa) · n8n bridge |

## Paths (guide, not a lock)

| Area | Smart Experience | Integrations Hub |
|---|---|---|
| `backend/app/Integrations/{Manifest,Vault,OAuth,Webhooks,Http}/`, `Calendar/` connectors, `Tasks/` connectors, `ConnectedCatalog`, `StatusResolver` | read only | **owns** |
| `backend/app/Integrations/Ai/*` (provider adapters) | **owns usage metering**; see Shared | owns key and provider selection (Phase 7) |
| `backend/resources/integrations/`, `config/integrations.php`, migrations for integration tables | read only | **owns** |
| `frontend/src/features/{connected,settings/Integrations*}`, hub components | read only | **owns** |
| `frontend/src/lib/{capture,quickAdd,voice}.ts`, `components/layout/QuickAdd.tsx` | **owns** | read only |
| `backend/app/Services/Discovery/`, `config/discovery.php`, `resources/discovery/**` (content), `Controllers/{Discovery,AdminRelease}Controller.php`, `frontend/src/features/discovery/`, `frontend/public/discovery/`, `styles/discovery.css` | **owns** | read only; may add `discovery/tours/integrations-*.json` for its own screens (H-008) |
| `backend/app/Services/{Assistant,Conversation,Copilot*,Weekly*,Morning*,Recommendation,Intelligence*,DayPlanner,Planning,Timeline,Conflict}*.php` | **owns** | read only |
| `frontend/src/features/{today,intelligence,progress,analytics,wellbeing,assistant,timeline}`, `AiControlCenter.tsx` | **owns** | read only |
| `frontend/src/styles/*` (mobile, RTL, tokens) | **owns** | edits only classes of its own components, in its own file where possible |
| `scripts/`, `.github/workflows/`, `docs/DEPLOYMENT.md` | neither (change only through a dedicated PR announced here) | same |

## Shared files — small, append-only hunks, announced in `HANDOFFS.md`

`backend/routes/web.php` · `backend/app/Providers/AppServiceProvider.php` · `backend/app/Services/AuditLogger.php` (`ACTIONS`) ·
`backend/tests/TestCase.php` · `docs/IMPLEMENTATION_STATUS.md` (each track appends its own `V<n>` section at the end) ·
`frontend/e2e/shard-weights.json` · `backend/config/*` · `backend/database/migrations/` (unique timestamps; never edit an applied migration).

## Working rules (both sessions)

1. **Before a task:** `git fetch`; read the state of `main`, its CI and the last deploy; read these four files; look at the other track's recent PRs.
2. **Isolation:** one branch per task and a separate `git worktree` per session (never switch branches in a tree another session is using).
3. **Staging:** `git add` explicit paths only, never `git add .`.
4. **After a task:** run the relevant tests, commit, push, open an independent PR to `main`, update `STATUS.md` (own section only) in the same PR or a small follow-up.
5. **Never:** merge, push to `main`, deploy by hand, touch `.env`, `APP_KEY`, Docker, n8n or production data; install tools or packages without the owner's approval.
6. **Need a change in the other track's area?** Do not make it. Add a row to `HANDOFFS.md`.
7. **Conflicts:** the later PR rebases on or merges `main`; contested files are resolved by the owner of the area, not by the author of the later PR.
