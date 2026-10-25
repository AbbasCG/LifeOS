# LifeOS implementation status

Updated: 2026-10-24 (latest phase updates at the end of this file). Progress describes verified capabilities, not estimated percentages.

## 1. Project Overview
LifeOS personal time and productivity workspace. Laravel 13 / PHP 8.3, PostgreSQL, React 19 / TypeScript / Vite 8 / Tailwind 4, Windows. Phase 1 audit complete; foundation underway. Not production ready.

## 2. Implementation Progress
| Module | Status | Progress | Notes |
|---|---|---|---|
| Authentication | Not started | Unimplemented | Laravel user model only |
| Dashboard | Partial | Mock UI | No API |
| Tasks | Not started | Unimplemented | No domain files |
| Calendar | Not started | Unimplemented | Placeholder |
| Smart Planning | Not started | Unimplemented | |
| Focus Mode | Partial | Local timer | No persistence |
| Projects | Not started | Unimplemented | Placeholder |
| Goals | Not started | Unimplemented | |
| Habits | Not started | Unimplemented | |
| Analytics | Not started | Unimplemented | Mock chart |
| AI Assistant | Not started | Unimplemented | |
| Notifications | Not started | Unimplemented | Disabled icon |
| Settings | Partial | Browser preferences | Theme/language only |
| Responsive Design | Partial | Existing shell | Not browser verified |
| Testing | Partial | Skeleton tests | Not yet run |

## 3. Completed Features
Audit 2026-10-19: inspected routes, models, migrations, tests, package manifests, layout, contexts and dashboard components. Existing theme modes and Arabic/English document direction preserved.

## 4. In-Progress Features
Foundation: verify database, install required Laravel Boost per backend/AGENTS.md, configure Sanctum, create schema and API.

## 5. Pending Features
Authentication; tasks/projects; events/planning/focus; goals/habits; real dashboard/analytics; preferences; assistant; reminders; QA.

## 6. Backend Status
Skeleton User model, welcome route, default users/cache/jobs migrations. No domain API or authorization yet.

## 7. Frontend Status
Responsive sidebar/topbar; theme/language contexts; mock dashboard and placeholder routes. Local focus timer. No API client or authentication.

## 8. Database Status
Existing environment configuration retained without exposing credentials. Migration status verification running. No destructive commands authorized or used.

## 9. Testing and Quality
PHP 8.3.29 and Composer 2.8.6 verified. Root artisan invocation failed because artisan is in backend; subsequent commands use backend working directory. No application tests run yet.

## 10. Blockers and Decisions
No .git in root/backend/frontend: no baseline diff available; preserve source and never commit or deploy. Keep existing stack. Use same-origin Vite proxy for cookie/CSRF authentication. Use UTC persisted instants and explicit user timezone. Deterministic planner must require acceptance.

## 11. Next Actions
1. Complete prerequisites and database check.
2. Implement authenticated ownership-scoped domain APIs and tests.
3. Integrate feature UI with real API.
4. Run build, tests and end-to-end checks.

## 12. Session Handoff
Active implementation. No features claimed complete. Original user specifications are in Codex attachments 87b9e9f6-845e-4aaa-b9dd-3b8a944dfb28 and 0e1265b5-a8e1-45cb-9a08-210d660bce97.
## Phase update — 2026-10-19
Foundation and core implementation now exist: Sanctum cookie authentication, protected frontend routes, ownership-scoped CRUD for tasks/projects/categories/events/goals/habits, timestamp-based focus sessions, settings/profile/export, deterministic proposal/accept/reject planning, real overview metrics, lazy feature screens. Additive migration 2026_10_19_194823_create_productivity_tables applied successfully to PostgreSQL. No existing tables dropped.

Backend test run: 12/13 passed; remaining auth guard failure fixed by explicitly selecting the web guard; rerun pending. Frontend integration build pending. Assistant read-only provider adapter and disabled fallback added; no live credentials tested. Reminders command added; scheduler verification pending. Broad requirements such as advanced calendar resizing, complete analytics, voice capture, widget customization, full internationalization and end-to-end QA remain in progress. No production readiness claim.

## Phase update — 2026-10-24 · Phase 1: backend intelligence, analytics, assistant, notifications
Audit (2026-10-24): repository is under git (`claude/magical-johnson-1s7q7b`); baseline backend 13/13 and frontend 7/7 tests passing; tsc clean; one lint warning in unused legacy `FocusWidget`. Found and fixed: case-sensitive search on PostgreSQL; planner wrote non-existent `calendar_events.task_version` attribute; `.env.example` targeted SQLite.

Added (backend):
- Migration `2026_10_24_162845_add_reminders_and_notification_details` (additive, reversible; verified up/down/up on PostgreSQL 16): `tasks.remind_at`, `inbox_notifications.kind`/`link`, indexes.
- `GET /api/briefing` (BriefingService): explainable task ranking (priority, overdue, due soon, in progress, quick win), today's agenda, next event, workload vs working hours, habits with streaks/at-risk, goal progress, bilingual rule-based suggestions with deep links.
- `GET /api/analytics?days=7|14|30|90` (AnalyticsService): daily series (completed/created/focus), totals, previous-period comparison, on-time rate, estimate accuracy, per-project and per-priority breakdowns, focus by hour/weekday, habit consistency, bilingual insights.
- HabitStreaks service (daily and weekly streaks); habit listing now includes current/longest streak and done-today.
- Assistant: local rule-based provider (prioritize, overdue, weekly review, habits, task breakdown) in English and Arabic; works with no API key; OpenAI failures fall back to local with a notice. Still read-only.
- Notifications: NotificationController with unread count, unread filter, read, read-all, delete (owner-scoped). Reminder command adds task `remind_at` reminders, overdue/due kinds and links.
- Task listing: case-insensitive search over title and description with escaped wildcards; filters `due=overdue|today|week|none|open`, `category_id`; sorts `priority`, `due_at`, `updated_at`.

Tests: 37/37 passing (160 assertions) on SQLite and on PostgreSQL 16. New: HabitStreaksTest (unit), InsightsTest, AssistantTest, NotificationTest, TaskQueryTest.

## Phase update — 2026-10-24 · Phase 2: frontend integration, design system, browser QA
Added (frontend):
- Dashboard driven by `/api/briefing`: time-of-day greeting, actionable suggestion cards, today stats with day-load meter, ranked "next moves" with reason chips and one-click focus, live agenda (past/now states), one-tap habit check-ins with streaks, goal progress, skeleton loading.
- Analytics: 7/14/30/90-day range, period-over-period change, Recharts trend/area and bar charts (lazy chunk), project/weekday/habit consistency bars, bilingual insights, accessible data-table view. Chart palette validated for colour-vision deficiency in both themes (light `#5455dc/#0891b2`, dark `#7173f0/#0aa3c2`).
- Calendar: hourly time grid for day/week (overlap lanes, now-line, click/double-click to create, drag flexible blocks to reschedule with confirmation) and an unscheduled-task tray for drag-to-time-block or one-click scheduling. Month/agenda views kept.
- Tasks: priority/due filters (`?due=` deep links), smart-priority and deadline sorts, Kanban drag-and-drop between statuses, reminder field, subtask counts, overdue highlighting; goals +/- progress; habit streaks.
- Notification center: unread badge with visibility-aware polling, mark read/all, delete, deep links.
- Assistant: chat UI, prompt chips, local/AI badge, focus links, apply suggested steps to an existing task or review as a new task.
- Design layer `styles/premium.css`: chart/status tokens for light and dark, motion (reveal, shimmer) with reduced-motion fallbacks, RTL-aware icons.

Fixed during browser QA:
- Shared throttle keys: `throttle:120,1` on the group and `throttle:10,1` on the assistant shared one counter, so any 10 API calls locked out the assistant. Replaced with named, independently keyed limiters (`api` 300/min, `assistant` 10/min, `auth` 6/min per email+IP plus 30/min per IP, `password-reset` 3/min). Regression test added.
- Calendar drop never fired (`effectAllowed=copy` vs `dropEffect=move`).
- Event kind class `fixed` collided with Tailwind's `.fixed { position: fixed }` (pre-existing in month view); renamed to `kind-*`.
- Manual time entries now count as focus time in briefing, analytics and overview.

Verification: backend 38/38 (188 assertions) on SQLite and PostgreSQL 16; frontend 12/12 Vitest, `tsc -b` clean, ESLint 0 errors (1 pre-existing warning in unused legacy `components/dashboard/FocusWidget.tsx`), production build OK. Playwright end-to-end against Laravel + Vite + PostgreSQL: register, seed, dashboard, notifications, overdue filter, Kanban move, calendar time-blocking, analytics, assistant, habits, Arabic + dark mode, 390px mobile (no horizontal overflow). Only console errors are the expected 401s from the logged-out `/api/user` probe.

### Module status (2026-10-24)
| Module | Status | Notes |
|---|---|---|
| Authentication | Working | Sanctum cookie auth, register/login/logout, reset, profile, sessions, delete; named rate limits. No email verification or 2FA. |
| Dashboard | Working | Briefing-driven; widget customization setting is stored but not yet applied. |
| Tasks | Working | CRUD, filters, sorts, Kanban DnD, subtasks, tags, recurrence, reminders. No manual ordering within a column. |
| Calendar | Working | Time grid, time blocking, drag reschedule. No drag-resize; no recurring events; no external calendar sync. |
| Smart planning | Working | Deterministic proposals with explicit accept/reject (unchanged this phase). |
| Focus | Working | Server-timed sessions; task preselect via `?task=`. |
| Projects / Goals / Habits | Working | Streaks, goal quick-adjust. Goals are not linked to projects. |
| Analytics | Working | See Phase 2. |
| AI assistant | Working | Local rule-based by default; OpenAI optional with fallback. Read-only; no Anthropic provider. |
| Notifications | Working (in-app) | Requires scheduler (`php artisan schedule:work` or cron). No email/push. |
| Settings | Working | Unchanged. |
| i18n / RTL, themes, responsive | Working | Verified in browser. Some server-generated strings (planner reasons) translate generically on the client. |

### Next actions
1. Commit this work after owner review (nothing committed or pushed).
2. Apply the dashboard widget preference; drag-resize calendar blocks; manual Kanban ordering.
3. Optional Anthropic/OpenAI provider selection; email/push delivery for reminders; email verification.
4. Weekly review flow combining analytics with next-week planning.
5. Remove or wire up legacy unused `src/pages/*`, `src/components/dashboard/*`, `src/data/dashboardMock.ts`.

## Phase 3 — Smart planning & premium experience (in progress, branch `claude/magical-johnson-1s7q7b` restarted from `main` @ f278bdb)
### 3.1 Backend (done)
- Migration `2026_10_24_171136_add_weekly_planning_and_reviews` (additive, reversible; verified up/down/up on PostgreSQL): `schedule_proposals.starts_on/days/summary/accepted_at` + index; new `weekly_reviews` table (unique per user+week). New model `WeeklyReview` (+ factory).
- `PlanningService` rewritten (same accept/reject contract, existing tests unchanged and passing):
  - Plans only *remaining* work: estimate − logged focus − already-scheduled future blocks.
  - Splits work into focus blocks (`focus_block_minutes`, default 60; remainders <15 min folded in), max 2 blocks per task per day, daily planned cap (`daily_focus_limit` or 85% of the work window), break buffer after every busy block.
  - Ranking reuses `BriefingService::score`; `priority_task_ids` boost (+60) for weekly-review picks; urgent/high tasks prefer the user's focus window.
  - Every block has bilingual `explanation`, `reasons`, `part/parts`, `key`, `manual` flag. Unschedulable tasks get `needed_minutes`, `reason`/`reason_ar` and typed `alternatives` (deadline, scope, horizon, next_week, swap, manual).
  - `summary`: per-day capacity/fixed/flexible/planned/free/load and `overloaded` (≥90%), overload suggestions pointing to the lightest day, totals.
  - `PATCH /api/plans/{id}`: edit pending proposals (move/remove/add blocks); validates ownership, past times, overlaps with calendar and within the plan; edited blocks become `manual` (manual blocks may sit outside work hours or after deadlines = manual override).
  - Accept tolerates partial/edited plans; auto blocks must still fit work hours, deadlines, and remaining estimate.
  - `GET /api/plans`, `GET /api/plans/{id}`, `GET /api/plans/missed` (past flexible blocks of open tasks with no focus logged that day), `GET /api/plans/insights?from=&days=` (planned vs actual per day/task, completion of planned tasks). `POST /api/plans` accepts `task_ids` (reschedule missed) and `priority_task_ids`.
- `GET /api/availability?date=&days=&min_minutes=`: free slots inside working hours (owner-scoped).
- Calendar protection: moving a fixed event's time requires `confirm_fixed: true` (422 `fixed` otherwise); conflict errors name the conflicting event and its times.
- Weekly review: `GET/PUT /api/reviews/{date}`, `POST /api/reviews/{date}/complete` (any date → its Monday in the user's timezone). Returns metrics (completed, unfinished, focus vs last week, on-time, habit consistency, estimate overruns), completed/unfinished lists, focus by day, planned vs actual, goals, habits, achievements, improvements, suggested priorities, and the saved review (reflection, decisions, priorities, status). Completing applies confirmed decisions (`done` → completed + next recurrence, `drop` → cancelled, `carry` → inbox→todo) and stores a snapshot.
- Settings: `dashboard.order` / `dashboard.hidden` (validated widget ids: suggestions, stats, next_moves, agenda, habits, goals, focus, weekly, review), `focus_block_minutes` (15–180), `daily_focus_limit` (30–900).
- Refactor: recurring-task spawning moved to `Task::createNextOccurrence()` (shared by task updates and reviews).
- Tests: 57/57 on SQLite and PostgreSQL (new: WeeklyPlanningTest, WeeklyReviewTest, CalendarSchedulingTest).

### 3.2 Frontend (done)
- **Shared UI:** `ToastProvider` (`components/ui/Toaster.tsx`, hook in `lib/toast.ts`; polite live region, actions such as Undo/Reload), `Drawer` (side panel on desktop, bottom sheet on mobile), `EmptyState`, `useApi` hook. Toasts wired into resource CRUD, completion, deletion, planning, review, calendar and dashboard.
- **Weekly planning (`/planning`):** horizon (today / next 7 days / next week), missed-work banner with one-click reschedule, planned-vs-actual bars, proposal overview (totals, per-day load strip, overload advice), blocks grouped by day with bilingual explanations, edit time/duration, remove, add manual blocks (`BlockEditor`), alternatives with actions (plan 7 days, add block, remove lower-priority block), save edits, accept, reject, recent proposals. Resumes the latest pending proposal.
- **Weekly review (`/review`, sidebar entry):** week switcher; 5-step workflow (Look back → Unfinished work → Habits & goals → Reflect → Next week) with draft autosave on every step, done/carry/drop decisions, 1–5 rating and three reflection prompts, up to 5 priorities, completion summary, and "Plan next week", which generates a proposal with `priority_task_ids`.
- **Advanced calendar:** pointer-event drag (mouse anywhere on a block; touch/pen via the grip) and bottom-edge resize; 15-minute snapping; live ghost with time range and red conflict state; optimistic save with Undo; conflicts rejected client-side and server-side; fixed events locked (lock icon, info toast on drag, explicit "confirm" checkbox in the edit form → `confirm_fixed`); free-time bands and daily free totals from `/api/availability` (toggle); drop-position hint for tray drag; tap-to-place mode for touch; keyboard support (Enter edits, Alt+↑/↓ moves, Alt+Shift+↑/↓ resizes); overlapping-events banner and outline. Day/week grid plus month/agenda (with free totals and +15 min). Pure math in `lib/calendar.ts` (unit tested).
- **Customizable dashboard:** widgets `suggestions, stats, next_moves, agenda, habits, goals, focus, weekly, review` rendered in saved order; `DashboardCustomizer` drawer with show/hide switches, drag reorder (pointer capture) and accessible up/down buttons, reset; persisted to `user_settings.preferences.dashboard` (PostgreSQL). `lib/dashboard.ts` normalizes old/unknown layouts. New "This week's plan" widget.
- **PWA:** `public/manifest.webmanifest` (shortcuts: Plan, Focus, Review), brand icons (`public/icons/*`; the favicon replaced Vite's default), `public/sw.js` (never handles `/api`, `/sanctum`, `/up` or non-GET; network-first shell with cached fallback and `offline.html`; cache-first hashed assets; versioned by `?v=__BUILD_ID__`; waits for the user before activating), `PwaManager` update toast with Reload, `useInstallPrompt` ("Install app" in the sidebar), `useOnline` + `OfflineBanner`, `OfflineScreen` instead of a login redirect when the server is unreachable, friendly network errors in `api()` (status 0). The service worker registers only in production builds. Set `LIFEOS_BUILD_ID` in CI for reproducible builds (defaults to a timestamp).
- **Mobile & design:** bottom tab bar (Today, Tasks, Calendar, Focus, More) with safe-area insets, sticky topbar, skip link, consistent focus rings, spacing/radius tokens, balanced headings, contextual empty states, reduced-motion respected. Settings gained focus-block length, daily focus limit and best-focus-hours.
- **New/changed frontend files:** `features/{PlanningPage,ReviewPage,CalendarPage,Dashboard,DashboardCustomizer,ResourcePage,SettingsPage}.tsx`, `components/layout/{MobileNav,OfflineBanner,OfflineScreen,PwaManager,AppLayout,Sidebar}.tsx`, `components/ui/{Toaster,Shared}.tsx`, `lib/{toast,pwa,dates,dashboard,calendar,useApi,api}.ts`, `contexts/AuthContext.tsx`, `routes/AppRoutes.tsx`, `styles/experience.css`, `main.tsx`, `App.tsx`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `public/{sw.js,offline.html,manifest.webmanifest,favicon.svg,icons/*}`.

### 3.3 Verification (2026-10-24)
- Backend: 57/57 tests (299 assertions) on SQLite and PostgreSQL 16; Pint clean on changed files.
- Frontend: 23/23 Vitest (new `tests/phase3.test.tsx`: calendar math, layout normalization, customizer save, planning edit→accept, review workflow, offline errors/banner); `tsc -b` clean; ESLint 0 errors (1 pre-existing warning in unused legacy `FocusWidget`); production build OK.
- Playwright against the production build (`vite preview` + Laravel + PostgreSQL): dashboard customize → persisted after reload; planning generate → explanations → remove → save & accept; calendar resize, move, conflict rejection (red ghost), fixed-event protection, tap-to-place, keyboard nudge; review decisions → complete → plan next week with priorities; service worker controls the page and its caches contain only shell and hashed assets (no `/api`); offline shows `OfflineScreen`/banner; Arabic + dark; 390px mobile without horizontal overflow and with the bottom nav.
- Fixed during QA: "0m free" noise on past days; completed-review priorities looked disabled; duplicate priority chips in the review picker.

### 3.4 Known limitations / remaining work
- Planning still schedules whole days in the user's timezone only; no recurring events, no external calendar sync.
- Touch dragging uses the grip/resize handles (body drag is mouse-only, so scrolling stays natural). Long-press-to-drag is not implemented.
- The service worker is not active in `npm run dev` (by design). The update prompt is verified by code path and registration only; a two-build upgrade was not exercised end to end.
- No push notifications (the PWA does not request notification permission). Reminders remain in-app.
- Pre-existing Pint style issues remain in untouched files (`config/app.php`, `tests/Feature/PlanningTest.php`, `tests/Feature/WorkspaceTest.php`).
- Legacy unused files (`src/pages/*`, `src/components/dashboard/*`, `src/data/dashboardMock.ts`) still present.

### 3.5 Pending manual acceptance tests
1. Install the PWA on Android Chrome and iOS Safari (Add to Home Screen); check icon, splash, standalone display, shortcuts.
2. Deploy two builds and confirm the "new version" toast and reload.
3. Real touch devices: grip drag, resize handle, tap-to-place, dashboard reorder in the drawer/bottom sheet.
4. Weekly planning with real data across a full week, including manual blocks outside working hours and overloaded days.
5. Weekly review on a Monday (it defaults to the previous week on Mon/Tue) and the decisions' effect on tasks, including recurring tasks.
6. Screen-reader pass (VoiceOver/TalkBack) for calendar keyboard help, toasts and stepper.

### 3.6 Next phase (suggested)
Phase 4: reliability and integrations — push notifications (Web Push with VAPID) for reminders; recurring events; Google/Outlook calendar import (read-only first); optional Claude/OpenAI provider for planning explanations; email verification/2FA; a Playwright suite committed to the repo and CI; removal of legacy files.

### Git
Branch `claude/magical-johnson-1s7q7b` was restarted from `main` (f278bdb) for Phase 3. Phase 3 is committed and pushed to that branch with owner approval for review. It is not merged into `main` and not deployed; merging waits for owner approval. The Phase 2 "Next actions" list above is historical; sections 3.4–3.6 are current.

## Phase 4 — Intelligent automation, AI integration & connected productivity (in progress)
Branch `claude/magical-johnson-1s7q7b` restarted from `main` @ 6a96c3a (Phase 3 merged via PR #2). Nothing committed until approved.

### 4.H GitHub CI (done)
- `.github/workflows/ci.yml`: Laravel job matrix (SQLite and PostgreSQL 16 service with throwaway CI-only credentials; migrations run against PostgreSQL; Pint `--test`; PHPUnit; `composer audit`) and React job (npm ci, ESLint, `tsc -b`, Vitest, production build with `LIFEOS_BUILD_ID=$GITHUB_SHA`, `npm audit --omit=dev --audit-level=high`). No repository secrets required.
- Formatted the three pre-existing Pint offenders (`config/app.php`, `PlanningTest.php`, `WorkspaceTest.php`) so the style gate passes; formatting only.
- Local run: composer audit and npm audit report no vulnerabilities.

### 4.A Recurring calendar (done)
- Migration `2026_10_24_185235_add_recurring_events` (additive, reversible; verified on PostgreSQL): `calendar_events.recurrence` (json rule), `timezone`, `recurrence_until` (indexed last date for count/until series), `remind_minutes`; new table `calendar_event_exceptions` (unique per event + original start; `cancelled` or overrides for title/description/kind/start/end).
- `CalendarService` (container singleton): RFC-5545-style expansion of daily/weekly/monthly/yearly rules with interval, weekdays, count or until; evaluated on the series' wall clock in its own timezone (DST-safe); months without the day and Feb 29 are skipped; capped iteration; occurrences expanded only within the requested window (one row per series, no unbounded rows). Applies exceptions, including occurrences moved into the window. `occurrences()`, `conflicts()`, `seriesConflicts()`, pluggable read-only sources (used by external calendars).
- `CalendarController`: `GET /api/calendar?from&to` (≤62 days, expanded occurrences); `POST /api/events`; `PATCH /api/events/{id}` with `scope=series|occurrence` + `occurrence_start`; `DELETE /api/events/{id}?scope=occurrence&occurrence_start=`. Single events reject overlaps (unchanged message); series report up to 5 clashes in the next 90 days and can be saved with `ignore_conflicts`. Fixed commitments (series or occurrence) still need `confirm_fixed`. Series edits shift exceptions with the series; rule changes drop exceptions that no longer match. The old event write path in `WorkspaceController`/`ResourceRequest` was removed (one implementation).
- Planner (generate, summary/overload, edit conflicts, accept), availability, and briefing now read the occurrence layer, so recurring and external commitments block time everywhere. Task-block queries ignore series rows. Data export includes exceptions.
- Frontend: `useCalendar` hook on `/api/calendar`; `EventForm` (recurrence builder: frequency, interval, weekday toggles, never/until/count, plain-language summary; reminder; scope picker "This event only / All events in the series"; delete occurrence vs series; fixed confirmation; "Save anyway" for series conflicts; read-only view for external events). Dragging or resizing a recurring occurrence changes only that occurrence (with Undo); recurring and external markers on blocks.
- Tests: `RecurringEventsTest` (14), `tests/v4.test.tsx` (4). Full backend suite green.

### 4.E Security & account management (done)
- Migration `2026_10_24_190103_add_two_factor_and_audit_log` (additive, reversible; verified on PostgreSQL): `users.two_factor_secret` (encrypted cast), `two_factor_recovery_codes` (encrypted array of SHA-256 hashes; plaintext shown once), `two_factor_confirmed_at`, `two_factor_last_step` (replay protection); `audit_logs` table (owner-scoped, cascade on account deletion; never stores secrets).
- `TwoFactorService`: RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step), verified against the RFC test vectors; replay-safe; base32; 8 single-use recovery codes. No new dependencies.
- Login: correct password + 2FA → `{two_factor: true}` and a 5-minute pending challenge in the session (no auth session yet); `POST /api/two-factor-challenge` with `code` or `recovery_code`. Rate limited 5/min per challenged account (cannot be reset by new sessions) + 20/min per IP.
- Sensitive actions use Laravel's `password.confirm` middleware (15-minute window, JSON 423) with `POST /api/security/confirm-password`: start 2FA setup, regenerate recovery codes, disable 2FA, revoke a session. Changing the account email now also requires the current password (hardening).
- Endpoints: `GET /api/security`, `POST /api/security/two-factor`, `POST /api/security/two-factor/confirm`, `POST /api/security/two-factor/recovery-codes`, `DELETE /api/security/two-factor`, `GET /api/sessions` (device, IP, last activity), `DELETE /api/sessions/{hash}`, `DELETE /api/sessions` (others; password), `GET /api/security/audit-log`.
- Audit actions: login, login_failed, logout, password changed/reset, email changed, 2FA enabled/disabled/challenge failed, recovery codes regenerated/used, sessions revoked, data exported (plus integration/push/AI/automation actions used by later modules).
- Frontend: Settings hub (`/settings` General, `/settings/security`); `ConfirmPasswordProvider` + `useSensitiveAction` (catch 423 → password dialog → retry once); dependency-free QR encoder `lib/qr.ts` (independently verified: 15/15 test codes decoded by OpenCV across versions 1–21, all EC levels, UTF-8) with manual key, copy and `otpauth://` link fallbacks; recovery codes dialog (copy/download, must acknowledge); per-device sign-out and "sign out all other devices"; security activity log; two-step login form with recovery-code option.
- Tests: `SecurityTest` (10), frontend security tests (3). Backend 80/80.

### 4.B External calendar integrations (done; real providers need credentials)
- Migration `2026_10_24_190945_create_calendar_integrations` (additive, reversible): `calendar_accounts` (provider, external account id, email, **encrypted** access/refresh tokens, expiry, status active|error|revoked, last sync/error, events count; unique per user+provider+account) and `external_events` (unique per account + external id → no duplicates).
- `app/Integrations/Calendar`: `CalendarProvider` interface, `OAuthProvider` base (authorization code + **PKCE S256**, token exchange/refresh, error mapping: 401/403/invalid_grant → `ProviderAuthException`, others → retryable `ProviderException`), `GoogleCalendarProvider` (scope `calendar.readonly`, calendarList + singleEvents paging, skips free/cancelled, all-day in calendar zone), `MicrosoftCalendarProvider` (scope `Calendars.Read`, calendarView with `Prefer: outlook.timezone="UTC"`, `@odata.nextLink` paging, skips free/cancelled, all-day in user zone), `CalendarProviders` registry. Read-only by construction: no write calls exist.
- `CalendarSyncService`: refresh tokens 2 minutes before expiry; import window −7/+90 days; upsert by external id; delete events removed upstream; revoked access → status `revoked`, in-app notification, audit entry, events hidden; transient errors keep existing data and are retried. `SyncCalendarAccount` job (unique per account, 4 tries, backoff 1/5/15 min); `lifeos:sync-calendars` scheduled every 15 minutes.
- Imported events feed `CalendarService` as a read-only source → calendar, availability, conflicts, planner and briefing treat them as busy time.
- Endpoints: `GET /api/integrations`, `POST /api/integrations/{google|outlook}/connect` (returns the provider URL; one-time state bound to the user, 10 minutes), `GET /api/integrations/{provider}/callback` (validates state/provider/user, exchanges code, stores tokens, first sync, redirects to `/settings/integrations?connected=` or `?error=state|denied|exchange`), `POST /api/integrations/accounts/{id}/sync`, `DELETE /api/integrations/accounts/{id}` (best-effort Google revoke; removes imported events). Tokens never appear in any response.
- Frontend: `/settings/integrations` — read-only explanation; per provider: "Not configured" with administrator setup steps (env vars + exact redirect URI) when credentials are missing; connect/reconnect, sync now, disconnect with confirmation, status and last error; external events render striped and read-only in the calendar.
- **Credentials required for real use**: `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET` (+ `MICROSOFT_TENANT`), redirect URIs `{FRONTEND_URL}/api/integrations/{google|outlook}/callback`, a queue worker and the scheduler. Without them the providers show "not configured"; no connection is simulated.
- Tests: `CalendarIntegrationTest` (10) using faked provider HTTP only in tests; 2 frontend tests. Backend 90/90.

### 4.C AI assistant v2 (done; external providers need API keys)
- Provider abstraction `app/Integrations/Ai`: `AiProvider` interface, `OpenAiProvider` (chat completions, JSON mode), `AnthropicProvider` (Messages API `claude-opus-5-5` by default, JSON-schema structured output, `output_config.effort` configurable, server-side refusal fallbacks enabled by default via `ANTHROPIC_FALLBACKS`; refusals / truncation / HTTP errors raise `AiException`), `AiProviders` registry. Both use Laravel's HTTP client — no new dependencies. The local rule-based assistant remains the fallback when no provider is configured, the provider fails, its output fails validation, or the user opts out.
- Safety model: providers only **interpret** (intent + structured scheduling request + text). Every provider answer is validated against a closed schema and server-side rules (intent whitelist, dates within 14 days, durations bounded). Times are computed by `AssistantActions` from real availability (`CalendarService` occurrences incl. recurring and imported events, working hours, breaks). Proposals are stored (`assistant_proposals`, expire after 24 h) and nothing changes until the user approves specific actions.
- Whitelisted actions: `create_event` (flexible block, optional link to an owned task) and `move_event` (only non-recurring, non-fixed LifeOS events, and only if the event hasn't changed since the suggestion). Apply runs in a transaction, re-checks ownership, staleness and conflicts; any failing action rolls back everything. Audited as `ai_action_executed`.
- New capabilities: natural-language scheduling in EN/AR ("I have four hours available tomorrow. Schedule studying, programming, and exercise." / "لدي أربع ساعات متاحة غداً. جدول الدراسة والبرمجة والرياضة."), with day/weekday/date, "after 6pm", per-item durations and task matching; overload detection + rebalancing proposals for the next 7 days; per-proposal explanations ("why this plan"). Existing priorities, overdue, weekly summary, habits and breakdown answers are preserved.
- Migration `2026_10_24_191750_create_assistant_proposals` (additive). Proposals are included in the data export.
- Endpoints: `POST /api/assistant` (now may return `proposal`), `GET /api/assistant/status` (active provider/model, configured flags — never keys), `GET /api/assistant/proposals/{id}`, `POST /api/assistant/proposals/{id}/apply` (`action_ids`), `POST /api/assistant/proposals/{id}/dismiss`. User preference `assistant_external` (PUT `/api/settings`) disables external AI per user.
- Frontend: `ProposalCard` (checkbox per change, from→to for moves, "why this plan", apply/dismiss, status), provider badge (Claude/OpenAI/local) and context-aware privacy note on the assistant page, new suggested prompts; `/settings/assistant` tab with provider status, admin setup hints and the external-AI opt-out.
- Config: `AI_PROVIDER` (disabled|openai|anthropic), `AI_TIMEOUT`, `OPENAI_API_KEY`, `OPENAI_MODEL` (legacy `AI_API_KEY`/`AI_MODEL` still honoured), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_FALLBACKS`.
- Tests: `AssistantActionsTest` (13: proposal around existing events without writes, partial approval + audit, atomic conflict re-check, tampered/unknown/foreign proposals, expiry/dismissal, task linking, Arabic, rebalance with staleness check, Anthropic request shape with server-computed times, invalid-schema and refusal fallbacks, opt-out + no key exposure), updated `AssistantTest` (8); 3 frontend tests. Backend 103/103.
- Needs real-world verification: live OpenAI/Claude responses (only faked HTTP is tested). No keys are committed.

### 4.D Smart notifications (done; browser push needs VAPID keys, HTTPS, queue worker)
- `Notifier` service is the single entry point: 7 categories (reminders, deadlines, calendar, focus, planning, review, system) with per-category in-app/push preferences (`notification_channels`), master switch and quiet hours respected (system notices always delivered in-app), deduplication by key (unique index + race-safe), in-app history record, push suppressed while a focus session is running (recorded as `suppressed`).
- `SendReminders` (scheduler, every 5 min) now uses `CalendarService` occurrences: **recurring** and imported events get reminders, per-event `remind_minutes` or the user default `event_remind_minutes` (default 30); focus-session completion (once), task reminders, deadlines/overdue (last 7 days), daily planning on work days at work start, weekly review at the end of the user's week. Per-user failures are isolated.
- Browser push without dependencies: `app/Integrations/Push/WebPush.php` implements VAPID (RFC 8292, ES256 JWT) and aes128gcm payload encryption (RFC 8291/8188) using OpenSSL. Verified independently: Python `cryptography` decrypted PHP-encrypted payloads and verified the VAPID signature; DER→JOSE signature conversion checked on 3000 signatures.
- `SendPushNotification` job (queue, unique per notification, up to 4 attempts, backoff 30s/2m/10m): idempotent (never re-sends a delivered notification), removes 404/410 subscriptions, drops a subscription after 5 rejections, records `push_status` (queued, retrying, sent, failed, suppressed, no_device), attempts and last error.
- SSRF protection: subscription endpoints must be HTTPS on an allow-listed push service host (`PUSH_ALLOWED_HOSTS`); endpoints and keys are **encrypted at rest** and never returned to the client; max 10 devices per user; subscribe/unsubscribe audited.
- Migration `2026_10_24_192843_add_smart_notifications` (additive): `inbox_notifications.category/body/push_status/push_attempts/push_error/pushed_at` + index, `push_subscriptions` table. Focus completion and integration-revoked notices now go through `Notifier`.
- Endpoints: `GET /api/push/config` (configured flag + public key + effective channels), `GET|POST /api/push/subscriptions`, `DELETE /api/push/subscriptions/{id}`, `POST /api/push/unsubscribe`, `POST /api/push/test` (in-app only when push isn't configured — never reported as pushed). Settings accept `notification_channels` and `event_remind_minutes`. `php artisan lifeos:vapid-keys` prints a key pair (never writes .env).
- Frontend: service worker `push` / `notificationclick` handlers (same-origin links only); `lib/push.ts`; `/settings/notifications` with honest device state (unsupported browser, no service worker in dev, not configured on server, permission denied with instructions, enabled), enable/disable/test, device list, per-category in-app/push matrix, event lead time, quiet-hours summary, and recent notification history with delivery status.
- **Required for real push**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, HTTPS origin, `php artisan queue:work` and `php artisan schedule:work` (or cron). Without them, everything works in-app and the UI says push is not set up.
- Tests: `SmartNotificationTest` (8: encrypted+signed delivery decrypted in-test as a browser would, dedupe, retry/410 cleanup, preferences/quiet hours/focus, recurring + custom-lead event reminders, focus completion once, endpoint allow-list/key validation/encryption at rest/ownership/audit, no push claims without configuration, preference validation); existing `NotificationTest` unchanged and passing; 2 frontend tests. Backend 111/111.
- Needs real-world verification: delivery through real FCM / Mozilla / Apple push services on devices.

### 4.F Automation engine (done)
- `AutomationEngine` with a fixed trigger → action catalogue (no arbitrary code or queries):
  - `task_overdue` (conditions: min priority, hours overdue, project) → `suggest_time_block` (creates an assistant proposal from real availability + notification linking to it) or `notify`.
  - `focus_completed` (min minutes) → `update_focus_stats` (moves the linked task from inbox/todo to in progress, sends today's focus total) or `notify`.
  - `recurring_task_due` (grace hours) → `create_next_occurrence` (creates the next recurring-task instance, always in the future, skips if one already exists; the missed task is left untouched) or `notify`. Recurring calendar events need no materialisation: occurrences are generated on read (no unbounded rows), so this trigger targets recurring tasks.
  - `weekly_review_completed` → `offer_next_week_plan` (drafts a weekly `ScheduleProposal` using the review's priorities; never auto-accepted) or `notify`.
  - `day_overloaded` (threshold %, days ahead) → `suggest_rebalance` (assistant rebalance proposal) or `notify`.
- Safety: every calendar change is a proposal requiring approval; rules only query their owner's data; max 20 rules per user; strict validation of conditions/config keys and trigger/action compatibility; project conditions must reference an owned project.
- Dedupe & retries: `automation_runs` has a unique (rule, dedupe key) — e.g. task id + due timestamp, focus session id, review id, date — claimed with `insertOrIgnore` before acting, so concurrent runs or re-delivered jobs can't double-act. Actions run in a transaction; failures are logged with the error and retried (atomic claim) up to 3 attempts. Statuses: succeeded, skipped (with reason), failed.
- Execution: polled triggers via `lifeos:automations` (scheduled every 15 min); event triggers via the queued `FireAutomations` job dispatched after commit from focus completion and weekly review completion.
- Migration `create_automations` (additive): `automation_rules`, `automation_runs`. Rules and runs are included in the data export; create/update/enable/disable/delete audited as `automation_changed`.
- Endpoints: `GET /api/automations` (rules + failed-run counts, catalogue, templates, limit), `POST /api/automations`, `PATCH|DELETE /api/automations/{id}`, `GET /api/automations/{id}/runs` (paginated log), `POST /api/automations/preview` (dry run: what would happen now, writes nothing).
- Frontend: `/settings/automations` — one-click suggested automations (the five examples), rule list with accessible on/off switches, run counts, failure badges, activity log dialog, and a builder (When / Then, trigger-specific conditions, actions filtered by trigger, optional custom message, preview). The assistant page opens `?proposal=<id>` links from automation notifications and shows the approval card.
- Tests: `AutomationTest` (9: CRUD/validation/ownership/audit, overdue → single proposal without calendar writes, focus completion via the real endpoint updates progress once, recurring next occurrence in the future and only once, review completion drafts an unaccepted plan, overload preview is read-only + rebalance proposal, failure logging with capped retries, disabled rules and other users ignored, rule limit); 2 frontend tests. Backend 120/120.

### 4.G Premium UI, mobile and QA (done)
- Settings hub tabs: General · Security · Notifications · Calendars · Assistant · Automations — all EN/AR, RTL/LTR, light/dark, keyboard accessible (tab links, real `role="switch"` toggles, dialogs close on Escape), reduced-motion respected; no existing screens redesigned.
- Assistant chat: provider badge (Claude / OpenAI / Local), context-aware privacy note, approval cards for proposals, deep link from automation notifications.
- Browser QA (Playwright, production build via `vite preview` + `artisan serve` + PostgreSQL), **0 console errors**:
  - Recurring event created via the form and rendered with recurrence markers.
  - "I have four hours available tomorrow. Schedule studying, programming, and exercise." → three blocks around an existing Dentist appointment with explanations; unchecking one and approving created exactly two events. Arabic request ("لدي ساعتين بعد الساعة 14 غداً…") produced a correct RTL proposal.
  - 2FA: password confirmation → QR + manual key → TOTP verification → recovery codes; logout → login challenge with a fresh TOTP → signed in.
  - Calendars / Assistant / Notifications settings show honest "not configured" states; test notification recorded in-app only.
  - Automations: suggested templates added, builder preview, keyboard toggle.
  - Arabic + dark and 390 px mobile screens: no horizontal overflow.
- Fixes found during QA: proposal card reused an existing `status-pending` class (wrong colours) → renamed; label/flex layout overrides in proposal, builder and notification settings; time-splitting now in 5-minute steps (4 h → 3 × 70 min instead of 3 × 60 min).

## Phase 4 summary

**Automated results (final run):** backend 120/120 tests, 748 assertions on SQLite **and** PostgreSQL 16; Pint clean; `composer audit` clean. Frontend 39/39 Vitest, `tsc -b` clean, ESLint 0 errors (1 pre-existing warning in `FocusWidget`), production build OK, `npm audit --omit=dev` 0 vulnerabilities. No dependencies were added (backend or frontend).

**Migrations (all additive, reversible, no data rewritten):** `add_recurring_events`, `add_two_factor_and_audit_log`, `create_calendar_integrations`, `create_assistant_proposals`, `add_smart_notifications`, `create_automations`.

**Verified only with automated tests / local QA — needs real-world verification:**
- Google and Microsoft OAuth + sync (requires registered OAuth apps; providers are faked in tests).
- OpenAI and Claude responses (faked HTTP in tests; request shape and fallbacks verified).
- Browser push delivery through real push services (crypto verified independently; delivery requires VAPID keys, HTTPS, a queue worker).
- Scheduler/queue in production (`schedule:work`/cron + `queue:work`).

**External configuration required (none committed):** `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET/TENANT` + redirect URIs; `AI_PROVIDER` with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT` (`php artisan lifeos:vapid-keys`); a queue worker and the scheduler. CI uses only throwaway database credentials.

**Manual acceptance tests:**
1. Create a weekly series (Mon/Wed/Fri), move one occurrence, delete another, then edit the whole series — exceptions follow or are dropped as described.
2. Enable 2FA with a real authenticator app; sign in on another browser with a code, then with a recovery code; revoke that session from Security.
3. With OAuth credentials: connect Google and Outlook, confirm events appear striped/read-only, revoke access at the provider, confirm the "Access revoked" state and notification; disconnect.
4. With an AI key: ask for a schedule in EN and AR, approve part of it; set "Allow the external AI provider" off and confirm the local assistant answers.
5. With VAPID keys over HTTPS: turn on push, send a test, block notifications in the browser and confirm the denied guidance; quiet hours suppress reminders.
6. Add the five suggested automations; make a task overdue, finish a focus session, complete a weekly review; check activity logs and approve the suggestions.

**Known limitations / next tasks:**
- External calendars are read-only by design (no write-back); all-day external events count as busy.
- Recurring calendar events are expanded on read (no per-occurrence rows); reminders are evaluated every 5 minutes, so lead times are ±5 min.
- Push subscription rotation (`pushsubscriptionchange`) is not re-registered automatically: if a browser rotates its subscription, the user turns push off and on again on that device (next task: re-sync the subscription on app start).
- The AI provider is chosen server-wide; per-user provider choice and streaming answers are possible follow-ups.

---

# V4.1 — Premium typography, realistic demo data & UX refinement

## 1. Font integration (done)
- Source: the supplied `fonts.zip` contained 7 WOFF2 (CFF) files, used **unmodified**:
  - Thmanyah Sans: Light 300, Regular 400, Medium 500, Bold 700, Black 900
  - Thmanyah Serif Display: Bold 700, Black 900
  - All cover Arabic, Arabic-Indic digits and basic Latin.
- **License — font files are NOT committed.** The Thmanyah Font License embedded in the files forbids uploading, hosting or redistributing the font files on any server, platform or file-sharing service (they may only be downloaded from Thmanyah's official site). The binaries are therefore git-ignored (`frontend/public/fonts/thmanyah/*.woff2`) and must be installed locally — see `frontend/public/fonts/thmanyah/README.md` (exact file names, download from https://font.thmanyah.com). Without them the app builds and works normally with Inter/system fallbacks (verified: build + tests pass with and without the files).
- **Before a public deployment**: the license also prohibits making the files extractable by end users "including through web embedding", while permitting embedding "as part of a compiled, packaged, or obfuscated product". Serving WOFF2 files from a public site may not be covered — obtain written confirmation from Thmanyah (ask@thmanyah.com) first.
- `frontend/src/styles/fonts.css`: `@font-face` for every file with `font-display: swap`, served from `/fonts/thmanyah/` (same origin, no CDN; the service worker caches them for offline/PWA use); weight *ranges* map the UI's 550/600 semibold to Medium (bold Arabic reads heavy).
  - **Arabic (RTL)**: `--font-arabic: "Thmanyah Sans", "Inter", system-ui…` — Latin words inside Arabic text use Thmanyah's matching Latin.
  - **English (LTR)**: `--font-latin: "Inter", "Thmanyah Sans Arabic", system-ui…` where "Thmanyah Sans Arabic" is the same files restricted by `unicode-range` to Arabic code points, so English pages keep Inter and only download Thmanyah when Arabic text appears.
  - **Display**: Arabic page titles (`h1`) and the assistant's empty-state heading use Thmanyah Serif Display Bold.
  - RTL safety: `letter-spacing` is neutralised in RTL (tracking breaks Arabic joining; several headings/eyebrows used negative/positive tracking), taller line-height for Arabic body and headings, tabular numerals for codes/times.
- Tajawal imports were removed (replaced by Thmanyah). The `@fontsource/tajawal` package is now unused but left in `package.json` to avoid changing dependencies without approval — it can be removed with `npm uninstall @fontsource/tajawal`.
- Verified in the browser: in Arabic the computed body font is Thmanyah Sans and every `h1` is Thmanyah Serif Display; loaded faces were Regular/Medium/Bold + Serif Bold; in English only Inter plus (for the Arabic language switcher label) Thmanyah Medium loaded. No horizontal overflow on any screen at 1440 px or 390 px in EN/AR, light/dark.

## 2. Demo data system (done)
- **Command:** `php artisan lifeos:demo` (wraps `Database\Seeders\LifeOSDemoSeeder`; `php artisan db:seed --class=LifeOSDemoSeeder` also works). Not called from `DatabaseSeeder`, so it never runs as part of a normal seed.
- **Guard (`App\Demo\DemoMode`)**: runs only when `APP_ENV` is `local` or `testing` **and** `LIFEOS_DEMO_ENABLED=true`; always refuses in production. The demo account is identified by `LIFEOS_DEMO_EMAIL` (default `demo@lifeos.local`) **and** a `demo_account` marker in its settings — if a real account owns that email, the command refuses to touch it.
- **Idempotent & scoped**: re-running removes only the demo account's previous records (by `user_id`; habit entries and event exceptions via their parents) and re-creates them; the account itself (and its id) is reused. Other users are never read or modified (tested by snapshotting another user's data before/after).
- **No side effects**: rows are written directly — no notifications sent, no jobs queued, no HTTP calls (tested with `Queue::fake`/`Http::fake`); no OAuth tokens, API keys, push subscriptions, calendar accounts or audit entries are created; the demo account has `assistant_external=false`, so it never sends data to an AI provider even if one is configured.
- **Deterministic**: fixed random seed; dates are relative to "today" in `LIFEOS_DEMO_TIMEZONE` (default Europe/Amsterdam), so the demo always looks current. Scenarios were verified on weekdays, weekends, midnight, a DST change and a leap day.
- **Coverage** (persona "Noor Haddad", a product designer studying data science, training for a half marathon, saving an emergency fund, learning calligraphy; EN or AR content via `--lang=ar`):
  - 5 categories; 8 projects with descriptions, statuses (active/paused/completed), due dates and milestones; 10 goals (career, learning, fitness, finance, personal) at varied progress.
  - 89 tasks: completed (with completion dates over ~8 weeks), overdue, upcoming, in progress, inbox, someday, cancelled, daily/weekly recurring; estimates, actual time from logged focus sessions, sub-steps, tags, reminders; linked to projects **and goals** (new `tasks.goal_id`).
  - 10 habits (daily and weekly) with ~300 check-ins over 60 days, active streaks (up to 24) and missed days.
  - Calendar: 6 recurring series (weekday stand-up, gym Mon/Wed/Fri, Thursday 1:1, Tuesday class with an end date, Sunday long run, monthly budget review) with a cancelled occurrence and a moved/renamed occurrence; ~50 single events across −21…+14 days (meetings, appointments, task blocks), fixed and flexible, generated without overlaps except one intentional double booking.
  - ~100 focus sessions over 58 days (focus/manual, a few cancelled, mid-week peaks).
  - 3 accepted historical weekly plans + 1 pending next-week plan produced by the real planner; 3 completed weekly reviews with reflections and snapshots computed from the data.
  - 18 notifications (read/unread, all categories); 6 automation rules (4 enabled, 2 disabled) with succeeded/skipped/failed run logs.
  - 2 pending proposals from the real scheduling logic: one from the overdue-task automation and one from the local assistant ("Studying, Programming, Exercise").
- **Scenarios**: productive day (yesterday: 5 focus sessions, several completions), overloaded day (≥90 % booked, shows in planning overload), a light next week with free focus time, overdue tasks with missed blocks offered for rescheduling, recurring events and tasks, habit streaks, goals approaching completion (90 %, 88 %), meaningful weekly review statistics, a pending AI scheduling proposal, an automation waiting for approval.
- Conversation history is not stored by the application (the assistant is stateless), so none is seeded.
- **Factories**: all previously empty model factories now produce realistic records, with states (`Task::factory()->completed()/overdue()/recurring()`, `CalendarEvent::factory()->flexible()`, `Habit::factory()->weekly()`).

### Demo setup
```bash
cd backend
php artisan migrate                       # additive migrations only
LIFEOS_DEMO_ENABLED=true php artisan lifeos:demo --password='choose-a-local-password'
# Arabic content and interface:
LIFEOS_DEMO_ENABLED=true php artisan lifeos:demo --lang=ar
# Remove only the demo records (keeps the account) / remove the account entirely:
LIFEOS_DEMO_ENABLED=true php artisan lifeos:demo --reset
LIFEOS_DEMO_ENABLED=true php artisan lifeos:demo --remove
```
Sign in at `/login` with `demo@lifeos.local` and the password you chose. Without `--password` (and no `LIFEOS_DEMO_PASSWORD`), a new account gets a random 20-character password printed once; re-running keeps the existing password. No demo password is committed. You can also put `LIFEOS_DEMO_ENABLED=true` (and optionally `LIFEOS_DEMO_PASSWORD`) in your local `.env`.

## 3. UX refinements found with the demo data
- Tasks — "Smart priority" sort now lists open tasks before completed/cancelled ones (finished urgent tasks used to sit at the top).
- Insights — percentages on tiny baselines are replaced by counts ("1 in the previous period"; insight "You completed 33 tasks, up from 1…") instead of "+3200 %".
- Smart planning — "Needs your attention" shows the first 4 items with "Show N more" (19 fully expanded cards buried the plan).
- Goals/projects — progress bars styled with the design system (were unstyled native bars) and coloured per goal; project rows show milestone progress (e.g. "2/4 milestones").
- Tasks — new optional **Goal** field in the task form (`goal_id`, validated as one of the user's goals; filter `?goal_id=`).
- Copilot — a "Waiting for your approval" section lists open proposals (`GET /api/assistant/proposals`) so pending suggestions are visible without a notification link.

**Migration:** `2026_10_24_195756_add_goal_id_to_tasks` (additive, nullable FK, `nullOnDelete`).

## 4. Automated verification (V4.1)
- Backend: **134/134 tests, 875 assertions on SQLite and PostgreSQL 16**; Pint clean; `composer audit` clean. New: `DemoSeederTest` (10: environment guard incl. production, volumes & relationships, scenarios through real services, idempotency + other users untouched + no jobs/HTTP, refusal to take over a real account, reset/remove scoping, demo login with external AI off, generated password + Arabic content, command output, scenario stability across dates), `FactoryTest`, smart-priority ordering, small-baseline insight, pending-proposal listing.
- Frontend: **43/43 Vitest** (new `typography.test.ts`: 12 local `@font-face` rules with swap, references exactly the 7 supplied files (and, when installed locally, that they are all present), RTL/LTR stacks, Arabic `unicode-range`, no letter-spacing in RTL, no CDN), `tsc -b` clean, ESLint 0 errors (1 pre-existing warning), production build OK with and without the locally installed font files, `npm audit --omit=dev` 0 vulnerabilities. No dependencies added.
- Browser QA (Playwright, production build, demo account, Europe/Amsterdam): all 14 main screens in EN light 1440 px, AR dark 1440 px and AR light 390 px — no page overflow, no console errors; fonts verified via computed styles and `document.fonts`.

## 5. Known limitations
- Times are formatted in the browser's timezone; the demo assumes the browser and the demo timezone match (Europe/Amsterdam by default — set `LIFEOS_DEMO_TIMEZONE` to yours).
- Demo content is static per language; switching the interface language does not translate already-seeded titles (re-seed with `--lang`).
- Thmanyah fonts must be installed locally on each machine/build server (not in Git); public web serving requires confirmation from Thmanyah.

---

# V5 — Adaptive Intelligence & Daily Experience

Branch: `claude/magical-johnson-1s7q7b`, restarted from `main` at `ab0c797` (V4/V4.1 merged as PR #3).

**Audit summary.** Reused rather than duplicated: `BriefingService` (ranking, agenda, habits, goals), `CalendarService` (recurring + imported occurrences), `PlanningService` (work hours, free intervals, overload summary, missed blocks, `ScheduleProposal` + accept flow), `AssistantService`/`AssistantActions` (providers, approval-gated proposals, audit), `AnalyticsService`, `HabitStreaks`, `WeeklyReviewService`, `AutomationEngine`, `Notifier`, focus-session API and the demo seeder. Missing before V5: self-reported check-ins, focus notes/distractions/modes/dedupe, goal milestones and goal/project/habit intelligence, energy- and boundary-aware day planning with alternatives, evening summary, analytics date ranges/project filter/energy correlation, copilot query/goal-planning/reflection skills.

### V5-C Energy, mood & workload check-ins (done)
- Migration `create_daily_checkins` (additive): one optional row per user and local date — energy, mood, stress, workload (1–5), sleep minutes (manual), reflection.
- `CheckinService`: daily series joining check-ins with the user's focus minutes and completed tasks; observational findings (energy vs focus, sleep vs focus, workload vs completed tasks, stress vs focus) only when each group has ≥ 3 days, with sample sizes shown and a "not medical advice" note; 7-day trends.
- Endpoints: `GET /api/checkins?days=`, `PUT /api/checkins/{date}` (today or up to 30 days back, user timezone; 422 when the module is off), `DELETE /api/checkins/{date}`, `DELETE /api/checkins` (all history, requires password confirmation, audited `checkins_deleted`), `GET /api/checkins/insights?days=`. Preference `checkins_enabled` (default on); turning it off stops prompts and planning use but keeps history until deleted. Included in the data export; never sent to AI providers.
- Frontend: accessible `CheckinCard` (radio-group scales, sleep hours, reflection); Settings → Wellbeing (toggle, today's check-in, patterns, history, delete-all with password confirmation).
- Tests: `CheckinTest` (4), 2 frontend tests.

### V5-D Advanced focus experience (done)
- Migration `add_focus_details` (additive): `focus_sessions.mode` (pomodoro|deep|custom), `project_id`, `cycle`, `notes`, `interruptions` (JSON log), `started_at`, `client_id` (unique per user) + index.
- API (backward compatible): `POST /api/focus-sessions` accepts `mode`, `cycle`, `project_id` (owned; derived from the task when omitted), `notes`, `client_id` — a retried request with the same `client_id` returns the existing session instead of creating a duplicate; manual time entries that overlap already-logged time are rejected. `PATCH` adds `interrupt` (reason phone|people|notifications|thought|other + note, max 50 per session) and `note` (edit notes, also after completion); `notes` can be sent with `finish`. Time is only added to a task once (status checked under a row lock). `GET /api/focus-sessions` now includes task/project titles. New `GET /api/focus-sessions/insights?days=` (`FocusInsights`): minutes, sessions, average, deep-work minutes, completion rate, planned vs actual, focus days, consistency, streak, distractions per hour and top reasons, peak hour/weekday, typical uninterrupted length, per-day/hour/project breakdowns, tips.
- Frontend: rebuilt Focus page — Pomodoro (25/5, long 15-minute break every 4th round with "next step" prompts), Deep work (90), Custom, Log time; task or project linking; large accessible dial (SVG, RTL-aware, reduced motion); pause/resume (Space shortcut), finish, discard; distraction logging with quick reasons; session notes; live remaining time in the tab title; optional browser notifications when the user grants permission (falls back silently when unsupported/denied); 30-day insights and history. Pure helpers in `lib/focus.ts` (incl. a UUID fallback for non-secure contexts).
- Tests: `FocusExperienceTest` (4: linking + idempotent retries + ownership, distractions/notes/pauses with time counted once, manual overlap rejection, insights maths), existing focus tests unchanged; 3 frontend tests.

### V5-F Goals, projects & habits intelligence (done)
- Migration `add_milestones_to_goals` (additive JSON `goals.milestones`, validated like project milestones; editable in the goal form).
- `GoalIntelligence` service:
  - **Goals** — percent vs expected pace (time used between creation and deadline), status `on_track | behind | at_risk | overdue | no_deadline | completed` with bilingual reasons, milestone progress and next milestone, linked-task counts, 14-day completion trend vs the previous 14 days, focus minutes (30 days), ranked next actions, recommendations (add a next step / block time / adjust an overdue goal), and goal-to-task suggestions from unfinished milestones not already present as tasks.
  - **Projects** — health `healthy | attention | at_risk | paused` from overdue tasks, inactivity, deadline vs milestone progress and missing next steps, with reasons.
  - **Habits** — 30-day consistency vs the previous 30 days, trend, current/longest streak, streak-at-risk flag, best weekday, suggestion.
- **Goal-aware prioritization**: `BriefingService::score/rank` accept goal pressure (at risk +25, overdue +30, behind +12, deadline within 14 days +8) with a new `goal` reason; used by the daily briefing, the weekly planner and the assistant. Weekly review data now includes `goal_health`.
- Endpoint: `GET /api/insights/progress` (`goals`, `projects`, `habits`).
- Frontend: `ProgressPanel` above the Goals (health cards with pace marker, reasons, trend, next action → Focus, recommendations, one-click "add milestone as task"), Projects (health list) and Habits (consistency, streak, trend, suggestions) lists.
- Tests: `GoalIntelligenceTest` (4), 1 frontend test.

### V5-B Adaptive daily planner (done)
- `DayPlanner` service (read-only until approved):
  - **Time budget** per day: boundary windows, committed time from `CalendarService` occurrences (recurring and imported events included), free time after **buffers** (`buffer_minutes`, default 10) around commitments, plannable capacity.
  - **Boundaries**: work hours (work days) plus optional `study_start/end` and `personal_start/end`; tasks follow their category's new `area` (work | study | personal; migration `add_area_to_categories`).
  - **Energy-aware**: today's check-in energy ≤ 2 → ~70% capacity and shorter blocks; 3 → 85%; peak focus window from the last 30 days of focus (best two hours) or the focus-hours setting; demanding/high-priority work goes there first.
  - **Duration estimation**: user's measured actual/estimate ratio over the last 90 days (≥ 5 tasks, clamped 0.8–1.5) stretches block sizes; carried as `estimate_factor` and honoured on accept.
  - **Priority-aware** ranking with goal pressure; **recovery**: missed blocks get a strong boost and are flagged `rescheduled`; **overload** detection when must-do work (overdue, due within ~2 days, urgent, missed) exceeds capacity, listing movable flexible events; **break recommendations** after 90+ minutes of continuous work; blocks shrink to fit gaps ≥ 30 min.
  - **Alternatives**: Balanced, Deep focus first (90-minute blocks in peak hours, fewer switches), Light day (~60% capacity, must-dos and top priorities) with metrics, unscheduled must-dos and per-item/global explanations; a recommended option (Light on low energy, Deep when big work and peak hours exist).
- `PlanningService`: config gains buffer and study/personal windows plus `windows()`; `accept()` now validates each block against its area's window and the estimate factor — the approval flow is unchanged and still re-checks conflicts, deadlines and task changes.
- Endpoints: `GET /api/day-plan?date=&replan=` (today … +14 days; nothing saved), `POST /api/day-plan {date, variant}` → pending one-day `ScheduleProposal` (replaces an older pending plan for that day); accept via the existing `POST /api/plans/{id}/accept`. New settings: `buffer_minutes`, `study_start/end`, `personal_start/end`.
- Frontend: `/today/plan` "Plan my day" — budget bar and stats, energy and peak hours, explanations, overload and recovery banners, three selectable plans with timeline preview, breaks and unscheduled must-dos, "Use this plan" → explicit "Add N blocks to calendar", "Replan from now", inline boundaries/buffer editor, today's fixed commitments (fixed/recurring/external icons). Category form gains a "Time boundary" field. "Plan my day" buttons now open this page.
- Tests: `DayPlannerTest` (5: budget with buffers + recurring + imported events, study boundary + low energy + estimate accuracy, overload + recovery + alternatives, choose → pending → accept with personal window, privacy); existing planning tests unchanged; 1 frontend test.

### V5-A Intelligent Today dashboard (done)
- `TodayService` + `GET /api/today` (read-only, one request feeds all Today widgets):
  - **Period-aware briefing**: morning/afternoon briefing (commitments and free time, top priority, deadlines, check-in nudge); after 18:00 or within 30 min of the end of work hours it becomes an **evening summary** (completed, carry-over, habits, tomorrow's first event) with a reflection prompt.
  - **Energy & workload**: today's check-in, load percent (committed + must-do vs window) and level light/moderate/heavy; hidden when check-ins are disabled.
  - **Available focus time**: free minutes and slots ≥ 30 min inside the day's boundary windows (reuses `PlanningService::windows/freeIntervals`, buffers after commitments), peak window and next best task.
  - **Deadlines**: next 7 days across tasks, projects and goals, bucketed overdue/today/tomorrow/week.
  - **Progress**: tasks done vs due today, focus minutes vs `daily_focus_limit` (default 240), habits done this period, overall.
- Dashboard: new widgets `today`, `progress`, `focus_time`, `checkin`, `deadlines`, `actions` (quick actions: add task, start focus, plan my day, check in, ask Copilot, weekly review) added to the customizable layout (`WorkspaceController::DASHBOARD_WIDGETS`, `src/lib/dashboard.ts`); existing saved layouts get them appended automatically. Each widget has skeleton loading and empty states; the check-in widget reuses `CheckinCard` in compact mode.
- Files: `app/Services/TodayService.php`, `InsightsController::today`, `src/features/today/TodayWidgets.tsx`, CSS in `experience.css`.
- Tests: `TodayTest` (3: morning briefing + slots + deadlines + progress, evening summary + energy level, privacy + widget layout); 2 frontend tests; the existing customizer test now expects `today` first in the default order.

### V5-E AI Personal Copilot v3 (done)
- Same safety pipeline as V4 — **interpret → validate → structured proposal → shown → explicit approval → re-validated execution → audit** (`ai_action_executed`). Providers (OpenAI / Anthropic) only *interpret*: they return an intent plus structured filters/targets in a closed JSON schema; the server computes every fact, date and change from the user's own data. Without a provider (or when the user opts out, or the provider fails/refuses/returns off-schema output) the local assistant answers in English or Arabic.
- New read-only intents (`CopilotService`):
  - **query** — "Show high priority tasks for project Website due this week", "اعرض مهام مشروع Website", "Which goals are at risk?": tasks filtered by project, goal, priority (high includes urgent), status and due window (overdue/today/tomorrow/week/none), ranked with goal pressure; projects/goals by health. Project/goal references resolve only among the user's own records (provider ids for other users' records simply match nothing).
  - **explain** — "Why is X not first?": rank position, score, reasons, the facts behind them and what ranks above it.
  - **conflicts** — calendar overlaps, overloaded days and deadlines whose remaining work exceeds the free time before them (next 7 days).
  - **reflection** — weekly progress summary (completed, open, focus vs last week only when last week had ≥ 60 min, habit consistency, goals needing attention) plus reflection questions grounded in the week and in check-in patterns; links to the weekly review.
- New proposals (whitelisted action types added to `AssistantActions::ACTION_TYPES`):
  - **goal_plan** → `create_task` actions: provider steps, otherwise the goal's unfinished milestones not already tasks, otherwise a short labelled template; due dates spread up to the goal deadline (weekly without one), high priority when the goal is at risk. On apply: title/priority/estimate validated, goal ownership re-checked, duplicate open task for the goal refused.
  - **triage** ("Reschedule my overdue tasks", "أجّل المهام المتأخرة") → `reschedule_task` actions: overdue tasks by priority get the end of the first work day with enough free time. On apply: task must still be open, owned and have the same deadline as when proposed; any stale action aborts the whole batch.
- Data minimisation for providers: in addition to the existing task/agenda/habit context, only project and goal **ids and titles** (max 30 each) are sent; no notes, descriptions, check-ins or other users' data.
- Frontend: proposal cards handle task actions ("Create N task(s)", "Reschedule N task(s)", old → new deadline), result items with health badges and links, new EN/AR prompt chips.
- Files: `app/Services/CopilotService.php` (new), `AssistantService` (intents, schema, routing), `AssistantActions` (`proposeGoalPlan`, `proposeTriage`, `executeTask`), `src/features/AssistantPage.tsx`, `src/features/assistant/ProposalCard.tsx`, `api.ts` types.
- Tests: `CopilotTest` (7: EN/AR queries with project/priority/deadline + isolation, explain, conflicts, goal plan approve/duplicate/tampered goal, triage stale-check + atomicity, reflection, provider interpretation limited to own records + minimal context); existing assistant tests unchanged; 2 frontend tests.

### V5-G Personal insights & analytics (done)
- `GET /api/analytics` now accepts `from`/`to` (local dates, `to` ≤ today, ≤ 1 year) besides the `days` presets, and `project_id` (validated against the user's own projects). The previous period is always the equally long span before; `range` returns both spans.
- Project filter applies to completions, created tasks, focus sessions (session project or its task's project), open-by-priority and period comparisons.
- New sections in `AnalyticsService::summary` (all existing fields unchanged):
  - **energy** — average focus and completions on low (1–2), medium (3) and high (4–5) energy check-in days; each group carries its day count and is `reliable` only with ≥ 3 days; insights are drawn only when two groups are reliable. Hidden when check-ins are off. Worded as patterns, never causes or medical advice.
  - **consistency** — days with focus, longest/current run, weekly focus and week-to-week variation (full weeks only, ≥ 2 needed).
  - **workload** — focus/completions by life area (category `area`), completions by weekday, open work due in the next 7 days.
  - **goals** — percent vs expected progress, status, days left and trend (hidden when a project filter is active).
  - **periods** — calendar-aligned this week vs last week up to the same moment, and month-to-date vs the same span last month.
- **Small baselines**: every comparison carries `small_base` (previous < 3 tasks or < 180 focus minutes); the period cards show the earlier amount ("too little to compare") instead of a percentage, as the stat cards already did.
- Frontend: custom date range form, project selector, range note, period cards, energy / consistency / workload / goal panels (`src/features/analytics/PatternPanels.tsx`).
- Tests: `AnalyticsV5Test` (3: custom range + project filter + validation, energy reliability threshold + disabled check-ins, consistency/workload/goals/periods with small-base flags); 1 frontend test.

### V5-I Demo data V5 (done)
- `LifeOSDemoSeeder` (still demo-account-only, guarded by `DemoMode`, idempotent, fixed seed, dates relative to today) now adds:
  - V5 settings: 10-minute buffers, study window 19:00–21:00, personal window 07:00–08:30, check-ins on.
  - Category **areas** (work, study, personal) and **goal milestones** for four goals.
  - Focus sessions with **mode** (pomodoro/deep/custom), project, Pomodoro cycle, **interruptions**, **notes** and `started_at`. These values are derived deterministically, without new `mt_rand` calls, so the V4.1 random sequence and its scenarios are unchanged.
  - About 50 **daily check-ins** over 60 days whose energy follows logged focus (with small deterministic noise), so the energy-vs-productivity panel shows a reliable, explainable pattern. Today is left open so the dashboard invites a check-in.
  - A pending **"Plan my day"** proposal for the next work day, built by the real `DayPlanner`.
  - Pending Copilot **goal plan** (habit tracker beta milestones) and **overdue triage** proposals, alongside the existing automation and scheduling proposals (4 pending in total).
  - Missed blocks and recovery reuse the existing V4.1 scenario.
- `DemoMode::OWNED_TABLES` includes `daily_checkins`, so reset and remove clean it up.
- `DemoSeederTest` asserts all of the above, and the multi-date scenario test checks the day plan on four different seed moments.

### V5-H UX & browser QA (done)
- Playwright against the production build (`vite preview` + `artisan serve` + PostgreSQL), demo account, Europe/Amsterdam. Covered 16 screens, including `/today/plan` and `/settings/wellbeing`, plus the Copilot chat and filtered analytics, in four configurations: EN light 1440 px, AR dark 1440 px, AR light 390 px and EN dark 390 px.
- **Result: no page overflow and no console errors in any run.** RTL was applied on every screen in Arabic.
- Interactions exercised:
  - all six Today widgets present; dashboard check-in saved;
  - three day-plan alternatives;
  - four pending proposals listed;
  - Copilot conflicts / explain / goals-at-risk (EN) and conflicts / explain / filtered query (AR);
  - analytics energy note, period cards and project filter.
- Fixed during QA:
  - The progress rings used the class `ring`, which collides with Tailwind's `ring` utility (a 1px box-shadow). Renamed to `progress-ring`.
  - The deadlines widget is capped at 6 items, with the existing "All" link.
  - The Copilot conflict check now lists only the first three deadlines that don't fit, plus a summary line. Once one deadline doesn't fit, every later one inherits the shortfall, so the rest were noise.
- Noted, not changed:
  - The weekly-review stepper scrolls horizontally at 390 px by design (Phase 3).
  - The closed mobile drawer sits off-canvas in RTL.
  - Browser QA must set the language through the account settings: the saved language overrides `localStorage` after login (existing behaviour).

### V5 verification (final run)
- Backend: **164/164 tests, 1180 assertions on SQLite and PostgreSQL 16**. Pint clean; `composer audit` reports no advisories.
- Frontend: **55/55 Vitest**; `tsc -b` clean; ESLint 0 errors (the 1 existing warning in legacy `FocusWidget`); production build OK (the existing `ResourcePage` dynamic-import notice); `npm audit --omit=dev` reports 0 vulnerabilities.
- **No dependencies added. Migrations are additive only:** `daily_checkins`, focus details, goal milestones, category area.

### V5 known limitations
- Copilot query and intent detection for the local assistant is keyword/regex based, for English and Arabic. Unusual phrasings fall back to help or the general plan. External providers interpret better but still only choose among the fixed intents.
- Goal-plan template steps are generic when a goal has no milestones; the UI says so.
- Copilot never edits or deletes existing tasks beyond rescheduling overdue deadlines; other changes stay in the regular UI.
- Energy, sleep and workload findings are correlations from the user's own entries, with minimum sample sizes. They are not causal and not medical advice.
- The analytics `goals` panel reflects current goal state, not the selected date range, and is hidden under a project filter (goals are not linked to projects).
- The day planner and Today slots use day-level work, study and personal windows. They do not yet model travel time or per-event energy cost.
- Browser QA scripts live outside the repository; a committed Playwright suite is still pending (see next phase).

### Manual test checklist (V5)
1. Dashboard: morning briefing before work end, and evening summary with a reflection prompt after 18:00. Check in from the widget and see the load badge update. Customize the layout so the new widgets can be hidden and reordered.
2. `/today/plan`: switch energy (check in low, then replan), compare Balanced, Deep and Light, then "Use this plan" → "Add N blocks to calendar". Edit study/personal boundaries and the buffer.
3. Focus: Pomodoro cycle with break suggestion; log a distraction; pause/resume with Space; finish with notes; check the insights panel.
4. Settings → Wellbeing: toggle check-ins off (the widget and energy analytics disappear), then delete history (password confirmation).
5. Goals/Projects/Habits: progress panels, goal milestones, "create tasks from milestones".
6. Copilot (EN and AR):
   - "Show high priority tasks for project X due this week";
   - "Why is … not first?";
   - "Do I have any conflicts?";
   - "Plan my goal …" → approve some tasks;
   - "Reschedule my overdue tasks" → change one task's deadline elsewhere, then apply. The stale suggestion should be refused.
   - "Help me reflect on my week".
7. Analytics: custom range, project filter, period cards on a fresh account (no percentages on tiny baselines), energy panel before and after three or more days per group.
8. Demo: `php artisan lifeos:demo` (local, `LIFEOS_DEMO_ENABLED=true`). Run it twice: the result is identical and no other accounts are touched.

## V5 extension — Living Workspace design & Connected Life

### Audit (before this extension)
- **Animation stack:** `motion` (Motion for React) was already a dependency, used only by four legacy dashboard components. There was no GSAP, three.js or React Three Fiber. Styling was a flat card dashboard: `workspace.css` → `premium.css` → `experience.css`.
- **V4 calendar integration (Google and Outlook)**, verified working and kept:
  - OAuth authorization code + PKCE, with a one-time state bound to user and expiry;
  - encrypted tokens that never reach the browser;
  - refresh two minutes before expiry; revoked access detected (401/403/`invalid_grant`), with a notification;
  - transient errors kept as `error` and retried by the queued job;
  - disconnect revokes at Google and deletes imported events; every route is owner-scoped; 10 feature tests.
- **Gaps found:**
  - every visible calendar was imported, with no choice;
  - no duplicate handling across accounts or against LifeOS blocks;
  - connected event titles were sent to external AI providers with no separate consent;
  - no extensible provider catalog.

### Updated plan (as executed)
| # | Item | Status |
|---|---|---|
| I1 | Calendar hardening: calendar selection, duplicate prevention, AI consent for connected data | done |
| I2 | Connected Accounts Hub: categories, honest states, read-only task providers (Google Tasks, Microsoft To Do, Todoist), list selection, copy-to-LifeOS without duplicates | done |
| D1 | LifeOS Living Workspace design system | done |
| D2 | Real interactive 3D: WebGL orb (dependency-free, lazy) | done |
| D3–D7 | Dashboard command center + day dial + guidance, immersive Focus, Copilot companion, goal journeys, habit heatmaps and completion feedback, calendar conflict and source cues, analytics explanations, mobile chrome | done |
| QA | Tests, browser checks (EN/AR, light/dark, desktop/mobile, reduced motion), performance measurements, docs | done |

### Dependency decisions and performance impact
- **No new dependencies.** I considered three.js / React Three Fiber / drei and decided against them: about 150 KB+ gzipped for one scene, plus a React reconciler. GSAP was not needed: every animation is either a spring (Motion) or CSS.
- **3D: a purpose-built WebGL 1 module** (`src/lib/orb/`):
  - **Size:** `renderer` chunk 11.1 KB (**4.6 KB gzipped**), lazy-loaded only where an orb is shown.
  - **Fallback:** a same-size CSS sphere is rendered first, so there's no layout shift. It stays when WebGL is unavailable, the context is lost, or a shader fails, and a single console warning names the reason.
- **Motion is now loaded lazily:** `LazyMotion` with `domMax` features in a separate chunk (31.7 KB gzipped, after first paint), using the lightweight `m` components.
  - Main bundle: **108.8 KB gzipped**, against 101.8 KB at the V4.1 commit (+7 KB for all of V5).
  - Before the switch to lazy loading it was 148.4 KB.
  - CSS is 25.9 KB gzipped (was 18.5 KB at V4.1).
- **Orb budget:**
  - 2,562 vertices (642 on touch devices); pixel ratio capped at 1.75 (1.5 on touch);
  - two draw calls; paused when off-screen (IntersectionObserver) or the tab is hidden;
  - **no animation loop with reduced motion** (frames are drawn on input or prop changes only).
- **Adaptive quality governor:** above about 25 ms per frame, it first drops to pixel ratio 1 and 642 vertices. If the page is still slow, it stops the continuous loop; the orb stays 3D and interactive.
- **Measured with headless Chromium on software rendering (SwiftShader, no GPU), dashboard at 1440 px:**

  | Configuration | Page FPS |
  |---|---|
  | Orb, first seconds | 18 |
  | Orb hidden | 59 |
  | Reduced motion | 61 |
  | Orb after the governor settles | **60** |

  The glass blur's cost was negligible (17 vs 18 FPS). A real GPU renders the full-quality orb well within budget.
- **Ambient light field:** pointer and scroll parallax is written to CSS variables at most once per animation frame, mouse only. Nothing moves with reduced motion.

### D1 — LifeOS Living Workspace design system (`src/styles/living.css`, loaded last)
- **Tokens:** layered glass surfaces (`--panel-bg`, `--chrome-bg`), hairlines, inner highlight, brand gradient and glow, aurora colours, soft and lift shadows, a spring easing (`--spring`, via CSS `linear()`). Separate light and dark values. When `backdrop-filter` is unsupported, surfaces fall back to solid.
- **Ambient light field** (`AmbientBackground`): three blurred light sources plus a faint dot grid with subtle parallax. Glass sidebar, topbar and bottom navigation. The brand wordmark uses the gradient.
- **Motion:**
  - spring page transitions on section change (`AppLayout`);
  - sliding spring indicators for the active sidebar item and mobile tab (`layoutId`);
  - press feedback, hover lift on stats and cards, checkbox pop, gradient sheen on primary buttons;
  - animated empty states (floating orb glyph).
  
  `MotionConfig reducedMotion="user"` and CSS media queries switch all of it off for reduced motion.

### D2 — Real interactive 3D: the LifeOS orb
- **What it is:** a WebGL icosphere displaced by 3D simplex noise, with per-vertex normals from finite differences, Lambert and Blinn lighting, and a Fresnel rim.
  - **Progress:** it fills from below to the current progress as a "liquid" level with a moving meniscus, and an orbiting ring of particles lights up with progress.
  - **Modes** change its motion: `idle`, `focus` (slow eight-second breathing), `paused`, `thinking`, `celebrate`.
- **Interaction:** drag to rotate with inertia; hover tilts it; tap or Enter/Space sends a pulse; arrow keys rotate it. It is focusable only when live, and has `role="img"` with a meaningful label (for example "Today's progress: 17%…").
- **Used where it carries meaning:**
  - the dashboard hero (today's overall progress);
  - Focus (session progress, inside the dial and in immersive mode);
  - Copilot (companion that "thinks" while waiting for an answer).
- **Bug found in browser QA:** GLSL ES requires uniforms shared by both shader stages to declare the same precision. `uTime` now declares `mediump` in both.
- **Tests:** icosphere counts and the 16-bit index budget; unit length; orthonormal rotation; perspective; colour parsing; ring layout; fallback rendering and labelling.

### D3–D7 — Core experiences
- **Dashboard command center (`CommandHero`):**
  - greeting, a one-line picture of the day, and the orb;
  - **contextual guidance** (`lib/guidance.ts`), which picks the single most useful next move from real data in priority order: overdue items (Copilot with a prefilled question), a morning check-in, a heavy day (lighter plan), evening reflection, free time plus the best next task, otherwise "Plan my day".
  
  Guidance only links somewhere. Copilot's `?ask=` **prefills, never sends**.
- **Day dial** (the "Today, in perspective" widget):
  - a 24-hour SVG clock of today's commitments, with connected calendars dashed in violet;
  - free focus slots, the user's work/study/personal windows and a live "now" hand;
  - arcs and the list are linked by hover/focus, and every arc is keyboard-focusable with a full label.
  
  It is anchored to the **user's** day through the new `day_start` field in `/api/today`, so a browser in another timezone can't misplace the arcs (a bug found in QA). `/api/today` also returns `timeline` and `windows`.
- **Focus:**
  - optional "3D ambience" (remembered per device; `localStorage` with try/catch) puts the orb inside the dial, filling with the session;
  - **Immersive mode:** a full-screen dialog with a large interactive orb, the timer, the task, pause/finish and exit (Esc).
- **Copilot:** an orb companion in the header, plus context chips built from today's situation (overdue → reschedule, due today, conflicts, evening reflection). They are de-duplicated against the prompt chips and only fill the composer.
- **Goals and habits:**
  - goal **journeys**: milestone stops along a path that fills with a spring as milestones complete, the next stop pulsing. Backed by `milestone_list` in `/api/insights/progress`.
  - **12-week habit heatmaps**, backed by `recent` and `color`.
  - **completion burst** when a habit is ticked on the dashboard (not rendered for reduced motion).
- **Calendar:** conflicting events carry a pulsing "!" badge on top of the existing outline; connected events use calm violet read-only stripes.
- **Analytics:** each core chart has a one-line "how to read this" explanation.
- **Mobile PWA:** glass bottom bar with a sliding active indicator and press feedback; the hero orb shrinks on small screens; RTL is respected throughout (journey fill direction, labels, mirrored icons).

### Connected Life — Connected Accounts Hub
- **Architecture:**
  - `ConnectedProvider` is the base contract: OAuth, account, `collections()`, scopes, environment keys, redirect URI.
  - `CalendarProvider` adds `events(…, $calendarIds)`; `TaskProvider` adds `tasks(…)`.
  - The shared `OAuthProvider` base (PKCE, token exchange and refresh, error translation) is unchanged.
  - The registry (`CalendarProviders`) holds all implemented providers. `ConnectedCatalog` groups them with the planned ones into **Calendars, Tasks, Productivity, Email, Coming later**.
  - Each card's state is honest: `available`, `needs_configuration` (with exact scopes, redirect URI and environment variables) or `planned` (an explanation and no connect button).
- **Implemented, all read-only:**

  | Provider | Category | Scopes | Credentials | Notes |
  |---|---|---|---|---|
  | Google Calendar | calendars | `calendar.readonly` | `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI` | V4, kept |
  | Outlook Calendar | calendars | `Calendars.Read`, `User.Read`, `offline_access` | `MICROSOFT_CLIENT_ID/SECRET/TENANT`, `MICROSOFT_REDIRECT_URI` | V4; now reads each chosen calendar |
  | Google Tasks | tasks | `tasks.readonly` | same Google client + `GOOGLE_TASKS_REDIRECT_URI` (default `/api/integrations/google_tasks/callback`) | date-only dues end that day in the user's timezone |
  | Microsoft To Do | tasks | `Tasks.Read`, `User.Read`, `offline_access` | same Entra app + `MICROSOFT_TODO_REDIRECT_URI` | open tasks only (`status ne 'completed'`) |
  | Todoist (API v1) | tasks | `data:read` | `TODOIST_CLIENT_ID/SECRET`, `TODOIST_REDIRECT_URI` | Todoist uses no PKCE and no refresh tokens (tokens do not expire); priority 4/3/2 → urgent/high/medium; floating times are read in the user's timezone |

- **Planned, documented, no connect button:**
  - **Notion:** one chosen database through a public integration.
  - **Gmail / Outlook Mail:** metadata only for starred or flagged messages, never bodies, never sent to AI without consent.
  - **Apple Calendar:** CalDAV with an app-specific password, since Apple offers no OAuth.
  - **ICS subscriptions.**
- **Setting up a provider (administrators):**
  1. Create the OAuth app: Google Cloud (enable the Calendar and/or Tasks API), Microsoft Entra ID (delegated permissions listed above), or the Todoist App Management Console.
  2. Add the redirect URI shown on the card.
  3. Set the variables in `backend/.env` and restart.

  Without credentials, a card shows "Needs server setup", and the connect endpoint returns 422. **Nothing is simulated.**
- **Choosing data (minimisation):**
  - New connections import **only the primary calendar or list**: `collections` is `[]` until it is first loaded, then only the primary entry is included.
  - Users tick more in the hub (`PATCH /api/integrations/accounts/{id}` with `{included: [...]}`, validated against the account's own collections). This re-syncs immediately, removes data from excluded collections, and is audited as `integration_collections_changed`.
  - Accounts connected before this change keep their previous behaviour (`collections` null → the provider's default set) until the user changes the selection.
- **Unified timeline and duplicate prevention:**
  - Imported events stay read-only occurrences with their source.
  - The same commitment from several accounts (same normalised title, start and end) is shown **once**.
  - An external event that mirrors a LifeOS block is hidden in favour of the editable LifeOS copy, which also removes false conflicts.
  - Imported tasks appear in a **"From connected apps"** panel on Tasks (source badge, list, due date, "Open in …" link) and in Today's deadlines (labelled with their source).
  - **Copy to LifeOS** (`POST /api/connected/tasks/{id}/copy`) creates a LifeOS task with a unique `source_ref`. Copying again returns the same task, and the imported one disappears from both views, so nothing shows twice. The source app is never changed (audited as `connected_task_copied`).
  - Disconnecting removes imported events and tasks but keeps copied LifeOS tasks.
- **Timezones:** events are normalised to UTC; Outlook all-day events are midnight-to-midnight in the user's zone; task dates follow the rules above.
- **AI privacy:** a new preference, `ai_connected_data`, is **off by default** and shown as a switch in the hub.
  - When off, external AI providers see connected events only as "Busy", and never see imported tasks.
  - The local assistant is unaffected. Email content is never imported.
- **Migration** `add_connected_life` (additive): `calendar_accounts.collections` (JSON), the `external_tasks` table, and `tasks.source_ref` (unique per user). `external_tasks` is included in the demo reset tables.
- **New endpoints:**
  - `PATCH /api/integrations/accounts/{id}`
  - `GET /api/connected/tasks`
  - `POST /api/connected/tasks/{id}/copy`
  
  `connect` and `callback` routes now accept `google_tasks`, `microsoft_todo` and `todoist`. `GET /api/integrations` adds `categories` and `ai_connected_data` while keeping `providers`.

### Verification (final run)
- **Backend:** **171/171 tests, 1264 assertions on SQLite and PostgreSQL 16.**
  - New `ConnectedAccountsTest` (7):
    - hub states and no secrets exposed;
    - primary-only import, then selection, re-sync and removal, foreign IDs and other users refused;
    - pre-selection accounts unchanged;
    - duplicates across accounts and against LifeOS;
    - Google Tasks import, copy without duplicates, and disconnect;
    - Todoist OAuth, date and priority parsing, non-expiring tokens;
    - AI masking with and without consent.
  - `CalendarIntegrationTest`: the Outlook test now covers calendar choice.
  - `TodayTest` covers the timeline and windows.
  - Pint clean; `composer audit` reports no advisories.
- **Frontend:** **66/66 Vitest.** New `living.test.tsx`: orb geometry, fallback, guidance priorities, dial math and linking, journey and heatmap labels, Copilot prefill without sending. Also: hub list choice, planned cards, consent switch, connected-task copy. `tsc -b` clean; ESLint 0 errors (the existing legacy warning); production build OK; `npm audit --omit=dev` reports 0 vulnerabilities.
- **Browser (Playwright, production build + `artisan serve` + PostgreSQL, demo account):**
  - Every screen in EN light 1440 px, AR dark 1440 px, AR light 390 px, and EN dark 390 px with **reduced motion**: no page overflow, no console errors, RTL applied.
  - Exercised: live WebGL orb (dashboard, Focus, Copilot); guidance; dial; 4 goal journeys; 10 habit heatmaps; 4 chart explanations; hub with 5 categories and correct state pills; Focus immersive mode open and Esc close.
- **Fixed during QA:**
  - shader precision mismatch;
  - shell stacking rule that let the skip link intercept taps on mobile;
  - dial anchored to the browser's day instead of the user's;
  - clipped dial centre;
  - duplicate switch in the hub;
  - mobile hero orb size;
  - topbar opacity;
  - accessible names of "Connect another … account" buttons.

### Known limitations (extension)
- **Not verified live:** the task providers are implemented from the providers' public APIs and verified with HTTP fakes only. No provider credentials were available in this environment.
  - Todoist API v1 field names (`results`, `next_cursor`, `due.date`) should be checked against a real account.
  - Todoist and Microsoft offer no programmatic token revocation; users remove LifeOS in the provider's settings.
- Imported tasks are read-only by design. Completing one in LifeOS requires copying it, and the source is not updated.
- Duplicate detection uses exact title and time matching. Renamed copies of the same meeting are not merged.
- ~~On the dial, times are displayed in the browser's timezone~~ — fixed in V6: labels use the account timezone (`TodayData.timezone`).
- Headless screenshots in Playwright's full-page mode render the sticky glass sidebar incorrectly; viewport screenshots are correct.
- Notion, Gmail, Outlook Mail, Apple Calendar and ICS feeds are planned only.

### Recommended next phase (V6)
- Commit a Playwright end-to-end suite (EN/AR, light/dark, mobile) to the repository and CI, seeded with the demo account.
- Copilot: optional on-device or provider-backed intent classifier, plus an "undo" for applied proposals (audit-linked reversal).
- Planner: carry unfinished day-plan blocks forward automatically (with approval); learn per-task-type estimates; respect travel buffers from event locations.
- Notifications: evening-summary and check-in reminders through the existing notification preferences.
- Analytics: export (CSV/PDF), and goal history snapshots so goal progress can follow the selected date range.


# V6 — Real integrations & connected intelligence

Branch `claude/magical-johnson-1s7q7b`, restarted after PR #4 (V5) was merged. **Not committed, not pushed** — waiting for approval.

## Phase 0 audit
- V5 + Living Workspace + Connected Accounts were merged to `main` (PR #4) before V6 started.
- **Gaps found in V5's sync:**
  - full re-read of 30 days on every run;
  - no rate-limit handling, and **Google rate-limit 403s were treated as a revoked account** (a real bug, now fixed);
  - no sync history;
  - cancelled recurring occurrences relied on a full re-read;
  - duplicate detection by title only;
  - completed connected tasks vanished instead of showing their state;
  - dial labels in the browser timezone.

## Module status

| Module | Status | Notes |
|---|---|---|
| V6-A Calendar sync (Google, Outlook) | **Done, verified with provider mocks** | incremental, rate limits, retries/back-off, scope check, DST, recurring/cancelled occurrences, account isolation |
| V6-B Task imports (Google Tasks, Microsoft To Do, Todoist) | **Done, verified with provider mocks** | list selection, pagination, incremental (Google/Microsoft), completion status, deadlines, attribution, copy-without-duplicates. Read-only: no two-way sync |
| V6-C Connected Accounts Hub | **Done** | per-account status, identity, permissions, selected collections, last success/attempt, sync mode, errors with next step, history, onboarding |
| V6-D Unified timeline | **Done** | `/timeline` day/week; all sources; filters by account, source, area, type and date; external items read-only; no duplicates |
| V6-E Conflicts & observability | **Done** | `ConflictService` with stable item IDs; `sync_runs` history; idempotent, locked, retry-safe sync |
| V6-F Connected AI planning | **Done** | find time / plan my day / deadline conflicts / better schedule tomorrow; proposal → approval → execution → audit; consent switch respected |
| V6-G Verification | **Done for automated checks; live accounts NOT VERIFIED** | see checklist below |
| V6-H UX refinement | **Done** | hub, timeline, onboarding, sync toasts, empty/error states, mobile, reduced motion, dial timezone fix |

## Sync design (V6-A/B)
- **Provider contract:**
  - `CalendarProvider::changes(token, calendarId, ?syncToken, from, to, tz): ChangeSet` and `TaskProvider::taskChanges(...)` return `upserts`, `removed`, `nextToken` and `full`.
  - Each provider owns its paging.
- **Google Calendar:**
  - The first read is `singleEvents=true` over the window (recurring series expanded into occurrences).
  - Later reads use `nextSyncToken`.
  - Cancelled occurrences, free/transparent events and events outside the window are removed.
  - `iCalUID`, `recurringEventId` and `originalStartTime` are kept.
- **Outlook:**
  - Uses `calendarView/delta` with `Prefer: outlook.timezone="UTC"` and following `@odata.nextLink` / `@odata.deltaLink`.
  - `@removed`, `isCancelled` and free/working-elsewhere events are removed.
  - Delta links are only followed on `graph.microsoft.com`.
- **Google Tasks:** `updatedMin` incremental with deleted tasks. **Microsoft To Do:** `tasks/delta`. **Todoist:** full read each time (no public incremental endpoint for this use).
- **Full re-reads:** a full read runs every 24 h (`FULL_SYNC_HOURS`) so the window moves forward. An expired token (410 `syncStateNotFound` / `resyncRequired`) falls back to a full read automatically.
- **Rate limits:**
  - These map to `RateLimitedException`: HTTP 429; 503 with `Retry-After`; Google 403 `rateLimitExceeded`, `userRateLimitExceeded` and `quotaExceeded`.
  - The delay is clamped to 30 s–1 h and stored as `retry_after`. The queued job `release()`s itself, and "Sync now" returns 429 with `retry_after`.
- **Back-off:** after 3 consecutive failures, scheduled syncs back off `min(6 h, 1 h·2^(n-3))`.
- **Idempotency:**
  - Upserts are keyed by `(account, calendar/list, external_id)`.
  - A cache lock `connected-sync:{id}` prevents parallel runs.
  - A partly failed run keeps the previous data and token for the failed collection only (`partial` status).
- **Scopes:**
  - On callback, the granted scopes are compared with `requiredScopes()`.
  - Unticking read access on the consent screen stores `scopes_ok=false`, shows "Permission missing", and blocks sync (422) until reconnect.
- **Revocation:**
  - `invalid_grant` or 401 after refresh sets the account to `revoked` and keeps the user's selections.
  - Disconnect revokes at Google (Microsoft and Todoist have no revocation endpoint) and deletes imported events and tasks plus tokens. Copied LifeOS tasks are kept.
- **Moves and cancellations:** a changed start is stored as `previous_starts_at` and `changed_at` (shown as "moved from …" and reported to Copilot). Cancellations are counted in the run details (up to 10 titles).
- **Stable de-duplication:** identity is `iCalUID` + original start, so the same meeting invited to Google and Outlook appears once even if renamed ("FW: …"). Title + time remains as a fallback.
- **Observability:**
  - `sync_runs` stores mode, trigger (`scheduled`/`manual`/`selection`/`connect`), status, counts, duration and an actionable error.
  - The hub shows the last 5 runs. Tokens never appear in runs, logs or API output.

## Timeline, conflicts and AI (V6-D/E/F)
- **`GET /api/timeline`:**
  - Parameters: `from`, `to` (≤ 31 days) and CSV filters `sources`, `accounts` (0 = LifeOS), `areas`, `kinds`.
  - Returns `range` (with timezone), `items`, `conflicts` and `facets`.
  - Item IDs are stable: `ev:e{id}`, `ev:x{id}`, `task:{id}`, `xt:{id}`, `focus:{id}`, `goal:{id}`, `habit:{id}:{date}`.
  - A copied connected task is shown once, as the LifeOS task.
  - Items are sorted all-day first, then by absolute time.
- **Conflict types:**
  - high severity: `overlap`, `busy_task` (planned work during a meeting), `deadline` (not enough free planning time before a due date);
  - informational: `duplicate`, `timezone` (organiser zone ≠ yours), `moved`, `cancelled`.
  - Conflicted items are flagged in the stream.
- **Copilot intents:**
  - `plan_day` ("Plan my day around my Google Calendar", "Suggest a better schedule for tomorrow") gives a read-only suggestion plus a deep link to `/today/plan?date=&variant=`.
  - `find_time` ("Find time for my study tasks") creates a **pending proposal** of `create_event` actions around all calendars, within area windows and before due dates. It is applied only on approval and audited.
  - `deadline_conflicts` ("Which deadlines conflict with my meetings?").
  - These work in English and Arabic, locally or through the external provider.
  - With `ai_connected_data` off, external AI sees connected events only as "Busy".
- **Never** written to Google, Outlook, Google Tasks, Microsoft To Do or Todoist.

## Migration
`2026_10_24_222618_add_sync_reliability` is additive and reversible (rollback and re-migrate verified):
- `calendar_accounts`: `sync_state`, `last_attempt_at`, `retry_after`, `consecutive_failures`, `scopes_ok`;
- `external_events`: `ical_uid`, `series_id`, `original_start`, `timezone`, `previous_starts_at`, `changed_at`;
- `external_tasks`: `status`, `completed_at`;
- new table `sync_runs`.

Existing accounts start with a full read.

## Verification (automated)
- **Backend:** **189/189 tests, 1412 assertions on SQLite and on PostgreSQL 16.**
  - New `SyncReliabilityTest` (11): incremental moves and cancellations plus 410 fallback; daily full read; Google 403 rate limit ≠ revocation; job honours `Retry-After`; partial sync; lock; scope check at connect; iCalUID de-duplication; Outlook delta across DST with cancelled occurrences; task incremental sync and completion; back-off and no secrets in the hub.
  - New `TimelineTest` (3) and `ConnectedPlanningTest` (4); existing suites updated for delta endpoints.
  - Pint clean; `composer audit`: no advisories.
- **Frontend:** **75/75 Vitest.** New `v6.test.tsx` (9): timeline sources, read-only state, conflicts, server filters, copy, week range, empty state; hub permissions, history, missing-scope/revoked/rate-limited states, 429 message, onboarding; dial timezone labels; day-plan deep link. `tsc -b` clean; ESLint 0 errors (1 pre-existing warning in `FocusWidget`); build OK (Timeline chunk 13.8 kB); `npm audit --omit=dev`: 0 vulnerabilities.
- **Browser (Playwright, production build, demo account on PostgreSQL):**
  - Timeline day, week and filters, plus hub and Today, in EN light 1440, AR dark 1440, EN dark 390 (reduced motion) and AR light 390 (reduced motion).
  - No horizontal overflow. No console errors apart from the expected pre-login 401.
- **Fixed during QA:**
  - week rows squeezed character-by-character (compact rows now stack time over title);
  - habits sorted out of order (mixed UTC offsets compared as strings);
  - mobile row actions wrapping onto their own line;
  - deadline-conflict wording when no meetings are involved.

## Real-account verification checklist
None of these were run: no provider credentials or consent were available in this environment. **Every item is NOT VERIFIED.**

| # | Check | Status |
|---|---|---|
| 1 | Google: connect, consent shows only `calendar.readonly`, primary calendar imported | NOT VERIFIED |
| 2 | Google: untick read access on consent → hub shows "Permission missing", sync blocked | NOT VERIFIED |
| 3 | Google: edit/move/cancel one occurrence of a recurring event → next incremental sync reflects it, "moved from" shown | NOT VERIFIED |
| 4 | Google: wait > 7 days idle or force 410 → automatic full read, no duplicates | NOT VERIFIED |
| 5 | Google: remove LifeOS at myaccount.google.com/permissions → account shows "Access revoked", reconnect keeps selections | NOT VERIFIED |
| 6 | Outlook (personal and work/school tenant): connect, choose calendars, delta sync, cancelled occurrence removed | NOT VERIFIED |
| 7 | Outlook: event across the DST change (last Sunday of March/October) shows the right local time | NOT VERIFIED |
| 8 | Same meeting in Google and Outlook appears once on Timeline (iCalUID) | NOT VERIFIED |
| 9 | Google Tasks: choose lists, complete a task at source → shows "Completed in Google Tasks", hidden after 7 days | NOT VERIFIED |
| 10 | Microsoft To Do: delta sync, completion, deleted task removed | NOT VERIFIED |
| 11 | Todoist API v1: field names (`results`, `next_cursor`, `due.date`) and pagination with > 200 tasks | NOT VERIFIED |
| 12 | Rate limit: real 429/403 from providers produces "Waiting for provider" and resumes | NOT VERIFIED |
| 13 | Disconnect removes imported data; Google token revoked at provider | NOT VERIFIED |
| 14 | Copilot "Find time…" proposal applied → only LifeOS events created, nothing written to the provider | NOT VERIFIED (verified with mocks: `Http::assertNothingSent`) |

**How to run them:**
1. Create the OAuth apps (see "Setting up a provider" in the V5 extension) with the redirect URIs shown in the hub.
2. Set `GOOGLE_*`, `MICROSOFT_*` and `TODOIST_*` in `backend/.env`.
3. Run `php artisan queue:work` and `php artisan schedule:work`.
4. Use test accounts, not personal data.
5. Record each result with the date and provider account type in this table.

## Security & performance summary
- **Tokens and access:**
  - Tokens are encrypted at rest (model casts), hidden from serialisation, and never logged or returned.
  - `sync_state` (sync tokens) is hidden as well.
  - Scopes are read-only, with no provider writes anywhere in code.
  - Outlook delta links are host-checked (no SSRF through `@odata.deltaLink`).
- **Isolation and limits:**
  - All queries are scoped by `user_id`; timeline account filters only match the user's own accounts.
  - Sync and connect are rate-limited (`throttle:auth`).
  - Every connect, disconnect, collection change, copy and applied proposal is audited.
- **AI:**
  - External AI receives connected events only as "Busy" unless the user enables `ai_connected_data`.
  - Copilot actions remain proposals until approved.
- **Performance:**
  - Incremental sync turns a 30-day re-read into a change list (typically a few events).
  - The calendar list is fetched once per run.
  - The timeline is bounded to 31 days with a single conflict pass.
  - The Timeline route is lazily loaded (13.8 kB).
  - No new dependencies and no new 3D. Animations are spring/opacity only and disabled under reduced motion.

## Known limitations (V6)
- **Live provider behaviour is unverified** (see the checklist).
- ~~Todoist has no incremental sync here~~ — fixed in V7 (Sync API with completion and deletion).
- ~~Outlook reports Windows timezone names~~ — fixed in V7 (mapped to IANA through ICU/CLDR).
- Google sync tokens can expire after long inactivity. This is handled by the 410 fallback and the daily full read.
- Microsoft and Todoist offer no token revocation; users remove LifeOS in the provider's settings.
- "Plan my day" through Copilot is a suggestion with a deep link; the plan itself is accepted on the Day Plan page.
- Imported tasks remain read-only. No two-way sync was built (requires explicit approval).
- Headless full-page screenshots render the sticky glass sidebar incorrectly (viewport screenshots are correct).

## Recommended V7 scope
- Run the real-account checklist with test tenants, then add recorded-fixture contract tests from those responses.
- Optional, approval-gated write-back: create LifeOS-planned blocks in a chosen Google/Outlook calendar, behind a separate write scope and per-action confirmation.
- Webhooks/push notifications (Google `events.watch`, Microsoft Graph subscriptions) instead of 15-minute polling.
- Map Windows to IANA timezones for Outlook so timezone-mismatch detection covers all events.
- Todoist incremental sync via the Sync API, including completed items.
- Commit the Playwright tour as a CI end-to-end suite (EN/AR, light/dark, mobile).
- Timeline: drag LifeOS blocks to reschedule (with conflict preview), and an ICS subscription source.


# V7 — Wider sources, safer changes

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` after PR #5 (V6) was merged. **Not committed, not pushed** — waiting for approval.

**Scope:** the V7 items from the V6 "Recommended V7 scope" that need neither new credentials, a public deployment nor a new dependency. Two items are **held for explicit approval** and were not built:
- **writing to Google/Outlook calendars**, which the standing rule "never modify external provider data without explicit authorization" forbids;
- **the Playwright end-to-end suite in CI**, which would add `@playwright/test` as a dev dependency.

Provider push notifications (Google `events.watch`, Graph subscriptions) were not built: they need a public HTTPS endpoint (and domain verification for Google), so they cannot be exercised here.

## Module status

| Module | Status | Notes |
|---|---|---|
| V7-A Outlook timezones | **Done** | Windows names → IANA through ICU/CLDR (`WindowsZones`); legacy aliases normalised; unknown/custom zones stay null. Timezone-mismatch conflicts now work for Outlook events. |
| V7-B Todoist incremental sync | **Done, verified with provider mocks** | Todoist API v1 `/sync` (`resource_types=["items"]`, `sync_token`), one read per run shared by all chosen projects. Completed tasks show "Completed in Todoist" (kept 7 days); deleted or moved-away tasks are removed. |
| V7-C Calendar subscriptions (ICS / webcal) | **Done** | Read-only, no sign-in. SSRF-safe fetching; RRULE expansion through LifeOS' own recurrence engine; conditional requests. |
| V7-D Move from the timeline | **Done** | Move a LifeOS event or one occurrence of a series with a live conflict preview, including connected calendars. Saving re-checks on the server. |
| V7-E Copilot undo | **Done** | Applied proposals can be undone for 24 h. Only changes still exactly as Copilot left them are reversed; anything else is kept and explained. Audited. |
| Calendar write-back | **Not built — needs explicit approval** | Would need write scopes and per-action confirmation. |
| Playwright E2E in CI | **Not built — needs dependency approval** | QA was run with the preinstalled Playwright (not committed). |
| Provider push notifications | **Deferred** | Needs a public HTTPS endpoint; 15-minute polling with incremental tokens remains. |

## Calendar subscriptions (ICS)
- **Connect:** `POST /api/integrations/ics` `{url}` with `throttle:auth`.
  - `webcal://` becomes `https://`.
  - The feed is read once to validate it, then imported right away.
  - The account shows the calendar name (`X-WR-CALNAME`) and host.
  - Limit: 20 subscriptions per user. Duplicates are refused.
- **The address is a credential:**
  - stored encrypted in `access_token`;
  - never returned by any endpoint, never written to audit metadata (only the host).
- **Fetching is SSRF-safe (`IcsFeedFetcher`):**
  - HTTPS on port 443 only; no user-info in the address.
  - Every resolved address must be public: no private, loopback, link-local/metadata, CGNAT or IPv6 ULA/link-local ranges.
  - The connection is **pinned** to the checked address (`CURLOPT_RESOLVE`), so DNS rebinding cannot redirect it.
  - Redirects are followed manually (at most 3) and re-checked.
  - 5 MB cap, 15 s timeout.
  - 401/403/404/410 mean the link was reset or unshared: the account is marked revoked with "paste the current link", and imported events are kept until the user decides.
  - 429/503 honour `Retry-After`.
- **Parsing (`IcsParser`):**
  - Handles folded lines, escaped text and `VALUE=DATE` all-day events (midnight to midnight in the user's zone).
  - `TZID` can be IANA, Windows or vendor-prefixed; floating times use `X-WR-TIMEZONE`, then the user's zone.
  - Supports `DTEND` / `DURATION`, `STATUS:CANCELLED`, `TRANSP:TRANSPARENT`, `EXDATE` and `RECURRENCE-ID` overrides.
  - `RRULE` with FREQ / INTERVAL / COUNT / UNTIL / weekly BYDAY (plus BYMONTHDAY/BYMONTH that restate DTSTART) is expanded by `CalendarService::occurrenceStarts`, so it is DST-correct.
  - Other rules (BYSETPOS, ordinal BYDAY such as "2TU", RDATE…) are **skipped, not guessed**. The count is stored in the run (`details.skipped`) and shown on the account.
  - Stable IDs: `sha256(UID):original start`; `ical_uid` takes part in cross-source de-duplication.
- **Sync token:** ETag / Last-Modified plus a body hash. An unchanged feed costs one conditional request and applies nothing; a changed feed is a full replacement of the window.

## Move with conflict preview
- `GET /api/timeline/preview?event_id&occurrence_start?&starts_at&ends_at` (read-only, ≤ 24 h) returns the overlapping commitments (title, source, read-only, minutes), plus `fixed` and `recurring`.
- Timeline event items now carry `meta.event_id` and `meta.occurrence_start` for LifeOS events only. Connected events have no move action.
- The dialog converts wall-clock times in the account timezone (DST-aware `zonedToUtc`) and previews as you type.
- **Move** stays disabled while anything clashes or for an unconfirmed fixed commitment.
- Saving uses the existing `PATCH /api/events/{id}` (with `scope=occurrence` for a series), which re-checks conflicts and fixed commitments.

## Copilot undo
- Each applied action now records its `before` / `after` state in `results`. There was no schema change: status `undone` fits the existing column.
- **`POST /api/assistant/proposals/{id}/undo`**, available for `AssistantProposal::UNDO_HOURS` (24 h), reverses newest first:
  - **created blocks:** deleted if unchanged;
  - **moved events:** restored if unchanged **and** the original time is still free;
  - **created tasks:** deleted only if untouched (same title and due date, still to-do, no time logged, no linked blocks or focus sessions);
  - **rescheduled deadlines:** restored if unchanged.
- Everything else is **kept**, with a reason ("changed since", "in use since", "original time is taken"). It is audited as `ai_action_undone` with reversed and kept counts.
- Proposals applied before V7 have no recorded state and are not undoable (`undo_until: null`).

## Verification (automated)
- **Backend:** **200/200 tests, 1559 assertions on SQLite and PostgreSQL 16.**
  - New `CalendarFeedsTest` (5):
    - recurring feed with EXDATE, override, all-day, cancelled, transparent, folded line, Windows TZID, floating time, across DST; unsupported rule counted; address never exposed and stored encrypted;
    - conditional 304 and changed feed;
    - 12 unsafe addresses refused with nothing sent, and a redirect into the private network refused;
    - non-calendar, oversized and reset links;
    - Windows → IANA and the Outlook timezone conflict.
  - New `CopilotUndoTest` (5). `TimelineTest` gained the move preview; `ConnectedAccountsTest` covers the Todoist Sync API.
  - Pint clean; `composer audit`: no advisories. **No migration in V7.**
- **Frontend:** **80/80 Vitest.** New `v7.test.tsx`: DST-aware zone conversion, subscription form and server error, feed account card, move dialog clash → free → occurrence-only PATCH, Copilot undo with kept items. `tsc -b` clean; ESLint 0 errors (1 pre-existing warning); build OK; `npm audit --omit=dev`: 0 vulnerabilities.
- **Browser (Playwright, production build, demo account on PostgreSQL), EN light 1440 and AR dark 390 with reduced motion:**
  - hub subscription card;
  - private-address refusal shown inline;
  - move dialog free → clash (Team stand-up, 15 min) with Move disabled;
  - Copilot schedule → apply → undo ("All changes undone.").
  - No overflow and no unexpected console errors (the 422 is the deliberate refusal).
  - Fixed during QA: the subscription card had no provider colour.

## Real-account checklist (V7 additions)
**Every item is NOT VERIFIED** (no provider credentials or live feeds in this environment).

| # | Check | Status |
|---|---|---|
| 15 | Todoist: incremental sync reports a task completed in Todoist as "Completed in Todoist" | NOT VERIFIED |
| 16 | Todoist: task moved to an unselected project disappears; deleted task disappears | NOT VERIFIED |
| 17 | ICS: Google Calendar "secret address in iCal format" subscribes and shows recurring events correctly | NOT VERIFIED |
| 18 | ICS: Outlook.com published calendar (Windows TZIDs) shows correct local times | NOT VERIFIED |
| 19 | ICS: Apple iCloud public calendar (webcal://) subscribes | NOT VERIFIED |
| 20 | ICS: resetting the secret link marks the subscription "no longer works" | NOT VERIFIED |
| 21 | ICS: conditional requests (ETag/Last-Modified) return 304 from real servers | NOT VERIFIED |
| 22 | Outlook: organiser in another timezone shows the timezone notice on Timeline | NOT VERIFIED |

## Known limitations (V7)
- **ICS:**
  - Complex recurrence rules are left out (and counted), not approximated.
  - `VTIMEZONE` definitions are not parsed; zones resolve by name (IANA/Windows/vendor prefix).
  - `RDATE` is ignored.
  - Feeds over 5 MB are refused.
  - http-only feeds are refused by design.
- Server validation messages from the subscription endpoint are in English, like other server validation errors.
- Moving is for LifeOS timed events; tasks, all-day events and connected events are not moved from the timeline.
- Undo is per proposal and only within 24 hours. It never touches connected providers (Copilot never writes to them).
- Todoist's Sync API full read lists active tasks only; tasks completed while LifeOS was not syncing incrementally are removed rather than shown as completed.

## Decisions recorded (2026-10-25)
- **Calendar write-back — design approved, not implemented.** Allowed only as an opt-in feature with:
  - separate OAuth write scopes;
  - explicit calendar selection;
  - a change preview and confirmation for every operation;
  - audit logging and safe error handling.

  Never automatic. This approval does not permit modifying any real calendar now.
- **`@playwright/test` as a dev dependency with browser tests in CI — approved, not implemented yet.** The tests must use isolated test data and never real accounts.
- **Proactive Personal AI is not started and not complete.** V7 is integration and workflow stabilisation only.

## Recommended next steps
- Implement the approved Playwright CI suite (isolated seeded data), then opt-in calendar write-back per the design above.
- Run the real-account checklist (items 1–22) with test accounts and record results.
- Provider push notifications once the app has a public HTTPS URL.
- Fuller RRULE support (BYSETPOS / ordinal BYDAY) in the shared recurrence engine, which would benefit LifeOS events too.
- Localised server validation messages.


# V8 — Browser tests in CI and opt-in calendar write-back

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` after PR #6 (V7) was merged. **Not committed, not pushed** — waiting for approval.

**This release contains Browser CI and Calendar Write-back only. Proactive Personal AI has NOT been implemented.** Both items were approved on 2026-10-25.

| Module | Status | Notes |
|---|---|---|
| V8-A Playwright browser tests in CI | **Done** | `@playwright/test` 1.63.0 (dev only), 6 specs × 2 projects, new `Browser (Playwright)` CI job. Isolated data; never real accounts. |
| V8-B Opt-in calendar write-back (Google, Outlook) | **Done, verified with provider mocks only** | Built exactly to the approved design. **No real calendar was modified.** Off unless `LIFEOS_CALENDAR_WRITE=true`. |

## V8-A — Browser tests (`frontend/e2e`, `frontend/playwright.config.ts`)
- **Servers:** the production build (`vite preview`) and the real Laravel app (`php -S` from `backend/public`) on a **throwaway SQLite database** (`backend/storage/e2e.sqlite`, git-ignored).
  - Recreated with `migrate:fresh` and the demo seeder on every run, using a random password.
  - Provider credentials and AI keys are forced empty; `LIFEOS_CALENDAR_WRITE=false`.
- **Fixtures (`e2e/fixtures.ts`) fail any test** that:
  - makes a request outside 127.0.0.1/localhost (such requests are also blocked);
  - throws a page error;
  - logs an unexpected console error.
- **Specs:**
  - `auth` — wrong password refused, then sign-in;
  - `smoke` — 15 screens render with demo data without horizontal overflow;
  - `timeline` — day/week, filters, move preview clash with Move disabled and nothing saved;
  - `copilot` — nothing changes before approval, apply, then undo restores;
  - `hub` — unconfigured providers never look connected; a private-network feed is refused;
  - `i18n` — Arabic is RTL on the main screens without overflow.
- **Projects:** Desktop Chrome 1440 px, and Pixel 7 in dark mode with reduced motion. One worker, because the demo account's language is a server-side preference.
- **Commands:** `npm run test:e2e` locally (after `npm run build`). CI installs Chromium with `npx playwright install --with-deps chromium` and uploads the report only on failure.
- **Tooling:** `tsconfig.e2e.json` adds type-checking for the specs; Vitest excludes `e2e/`; ESLint turns off the React-hooks rule for Playwright's `use()`.

## V8-B — Opt-in write-back
Every element of the approved design:

| Requirement | Implementation |
|---|---|
| Opt-in only | Server flag `LIFEOS_CALENDAR_WRITE` (default false; `config/calendar_write.php`). Per account, the user must also grant permission and pick a calendar. |
| Separate OAuth write scopes | Read connect still asks only `calendar.readonly` / `Calendars.Read`. "Allow adding events…" starts a **second consent** (`POST /api/integrations/accounts/{id}/write/connect`) for `https://www.googleapis.com/auth/calendar.events` / `Calendars.ReadWrite`, with `login_hint`. The callback refuses another account (`error=write_account`) or a missing write scope (`error=write_scope`; `calendar.events.readonly` does not count) and then changes nothing. |
| Explicit calendar selection | `GET …/write/calendars` lists only writable calendars (Google `minAccessRole=writer`, Graph `canEdit`). `PUT …/write {calendar_id}` validates against that list; `null` turns writing off. Nothing can be written before a calendar is picked. |
| Change preview | `POST /api/calendar-write/preview {op: create\|update\|delete, account_id, event_id\|link_id}` returns the target account and calendar, `before` and `after`, plus an **encrypted, single-use token** valid for 10 minutes. No provider request is made. |
| Confirmation for every operation | `POST /api/calendar-write/confirm {token}` performs exactly that one change. Re-use, forgery, expiry or another user's token → 422. **Any change since the preview** (event, copy, account, calendar) → 409. A per-account lock prevents concurrent writes. |
| Only LifeOS's own events | Creates copies of **single, non-repeating** LifeOS events. Updates and deletes apply only to copies recorded in `calendar_write_links`. Writes use the provider's **etag (`If-Match`)**, so an event edited in Google/Outlook is never overwritten (412 → "changed there, left alone"). |
| Audit logging | `calendar_write_granted`, `calendar_write_enabled`, `calendar_write_disabled`, `calendar_write` (op, provider, account, event, link) and `calendar_write_failed` (with a reason). Tokens and etags are never logged or returned. |
| Safe error handling | Writes are **never retried automatically**. A lost answer → "may or may not have been made — check before trying again" with no local change. Creation is idempotent: a Google client-chosen id (`lifeos…`; a 409 retry fetches the existing copy) and a Graph `transactionId`. 403 → "did not allow this change"; 404/410 on update → the stale link is dropped; 429 → slow down; a 401 marks the account revoked. Read access is unaffected by write errors. |
| Never automatic | Sync, the scheduler and automations only read (tested). Copies that come back through sync are hidden in favour of the LifeOS event. |

- **UI:**
  - **Hub:** an "Add events to …" section per Google/Outlook account (Off → Allow…; pick calendar → Turn on; On → Turn off), with orphaned copies (LifeOS event deleted) removable via preview. The disconnect dialog warns that added events stay in the provider.
  - **Timeline:** a "Send to a calendar" button on single LifeOS events opens a dialog per target: Add, Update when out of date, or Remove. Each goes through the preview, then "Confirm: …".
- **Migration `add_calendar_write_back`** (additive, reversible; rollback verified on PostgreSQL):
  - `calendar_accounts.write_granted_at`, `write_calendar_id`, `write_calendar_name`;
  - new table `calendar_write_links`; `calendar_event_id` is set to null on delete so copies can still be removed.

## Verification (automated)
- **Backend:** **207/207 tests on SQLite and PostgreSQL 16.**
  - New `CalendarWriteBackTest` (7): flag off; separate consent (wrong scope, read-only variant, other account, calendar choice); preview → single confirm → audit, with re-use/forgery refused and the copy de-duplicated; etag-guarded update/delete and orphans; changed-since-preview 409, lost answer, idempotent retry, repeating events refused; Outlook UTC + `transactionId` + editable calendars only; sync and automations never write.
  - Pint clean; `composer audit` clean.
- **Frontend:** **84/84 Vitest** (new `v8.test.tsx`). `tsc -b` (incl. e2e) clean; ESLint 0 errors (1 pre-existing warning); build OK; `npm audit --omit=dev` 0.
- **Browser:** **12/12 Playwright** (6 specs × desktop + mobile) locally.
- **Manual visual check:** the write UI with a temporary fake account on the dev database (EN light 1440, AR dark 390). No request left 127.0.0.1, Confirm was never clicked, and the account was deleted afterwards.

## Real-account checklist (V8 additions)
**Every item is NOT VERIFIED.** No real calendar was modified, as instructed.

| # | Check | Status |
|---|---|---|
| 23 | Google: "Allow adding events" consent shows calendar.events and returns to the same account | NOT VERIFIED |
| 24 | Google: event added to the chosen calendar at the right local time; appears once in LifeOS | NOT VERIFIED |
| 25 | Google: editing the copy in Google, then "Update" → refused as changed (etag) | NOT VERIFIED |
| 26 | Google: client-chosen id accepted; a repeated confirm does not create a duplicate | NOT VERIFIED |
| 27 | Outlook: Calendars.ReadWrite consent (personal and work/school, incl. admin-consent tenants) | NOT VERIFIED |
| 28 | Outlook: `transactionId` prevents duplicates on retry; `If-Match` with `@odata.etag` enforced on PATCH/DELETE | NOT VERIFIED |
| 29 | Removing a copy deletes only that event; revoking access in the provider is reported, not retried | NOT VERIFIED |
| 30 | Browser suite passes in GitHub Actions (Chromium install, PHP built-in server) | NOT VERIFIED until the PR's CI runs |

## Known limitations (V8)
- Write-back covers single LifeOS events only (no series or occurrences), one target calendar per account, and Google/Outlook only.
- "Turn off" stops new writes but cannot withdraw a granted OAuth scope; the UI explains how to remove it in the provider.
- Outlook's behaviour on a repeated `transactionId` is not verified; LifeOS reports "check Outlook" instead of assuming.
- Copies are not updated automatically when a LifeOS event changes; the timeline shows "Copy is out of date" and the user confirms an update.
- The browser suite uses one demo account and runs serially (about 1.5 minutes locally).

## Recommended next steps
- Run checklist items 23–30 with test accounts once the user wants live verification.
- Proactive Personal AI: write a spec (signals, when it may speak, consent, data limits) for approval before building.


# V9 — Proactive Personal AI

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` after PR #7 (V8) was merged. Merged into `main` as PR #8.

This release implements Proactive Personal AI as specified in the V9 prompt.
- **Deterministic by design.** Every insight is computed on the server from the user's own data, with stated confidence and sources.
- **External AI is optional and used in one place only:** the weekly summary, which needs two opt-ins and receives numbers only.
- **Nothing changes user data on its own.**

## Phase 0 — Audit
- **Reused, not duplicated:**
  - `BriefingService::score/rank` (priority scoring);
  - `PlanningService` (config, windows, free intervals, workload summary);
  - `CalendarService` (occurrences incl. connected calendars);
  - `ConflictService` (overlaps, busy tasks, deadline risk);
  - `GoalIntelligence` (goal pace, habit trends);
  - `FocusInsights`;
  - `DayPlanner` (variants, explanations, proposal → accept);
  - `WeeklyReviewService`;
  - `AssistantActions` (proposals with approval, re-validation and undo);
  - `Notifier` (preferences, quiet hours, dedupe);
  - the AI provider layer (`AssistantService::provider`, which already respects `assistant_external`);
  - `AuditLogger`.
- **Gaps found:**
  1. no record of postponed deadlines;
  2. no persisted, dismissible or deduplicated recommendations;
  3. no single insight model with confidence and sources;
  4. no AI preferences or data-source permissions beyond `assistant_external` / `ai_connected_data`;
  5. the planner had no deadline-first strategy and no interruption input;
  6. the weekly review mixed facts and advice;
  7. no AI activity history or AI-data deletion;
  8. demo reset missed `calendar_write_links` (V8) — fixed.
- **Dependencies:** none added (backend or frontend).
- **One migration** (additive, reversible; rollback verified on PostgreSQL).

## Module status

| Phase | Status | Implementation |
|---|---|---|
| 1 Personal intelligence engine | **Done** | `IntelligenceService` snapshot: priorities with a 0–100 score, reasons, risk, confidence and sources; deadline risk; 7-day workload; focus windows; focus capacity with confidence from history; high-severity conflicts; goals/habits needing attention; unfinished and repeatedly postponed work. Only allowed data sources are read. Cached per request. |
| 2 Morning intelligence | **Done** | `GET /api/intelligence/briefing` plus a new **Morning intelligence** Today widget (tabs: Priorities, Today, Focus, Watch-outs; up to 3 suggestions). Added to the dashboard layout (customisable, can be hidden). |
| 3 Adaptive planner | **Done** | `DayPlanner` gains a **Deadlines first** strategy, interruption-aware re-planning (`busy_until`, `lost_minutes`), and the user's preferred strategy. Low energy still wins. Choosing still creates a pending proposal; the calendar changes only on accept. |
| 4 Proactive Copilot | **Done** | `RecommendationService` + `recommendations` table. Types: deadline, conflict, overload, goal, postponed, focus. Deduplicated by stable key, dismissible, snoozable (1/3/7 days), auto-resolved, rated, opt-in tuning, at most 6 active. Acting creates an existing Copilot proposal (approval + undo) or only navigates. |
| 5 Weekly intelligence | **Done** | `WeeklyIntelligence`: measured **facts**, rule-based **interpretations** citing their evidence with confidence, workload pattern, next-week suggestions. Optional AI summary with a deterministic fallback, always labelled. |
| 6 Personalization & privacy | **Done** | `preferences.intelligence`: master switch, 5 feature switches, 6 data-source permissions, frequency (off / in-app / daily digest), opt-in personalization, retention (30/90/180 days), preferred planning strategy. Reset personalization; delete AI data. Existing external-AI consents are surfaced. |
| 7 AI Control Center | **Done** | `/settings/ai` (EN/RTL AR) covering all of the above plus an activity history (proposals, suggestions, AI audit log). |
| 8 Premium UX | **Done** | Living Workspace tokens, spring/opacity motion only (off under reduced motion), no new 3D, responsive 390/820/1440, dark/light, consistent skeleton/empty/error states. |
| 9 Testing | **Done** | See the matrix below. |
| 10 Documentation | **Done** | This section. |

## Architecture

```
            user's own data (tasks, events, connected calendars*, goals*, habits*, focus*, check-ins*)   * = permission
                                              │
         ┌──────────── existing engines (unchanged APIs) ────────────┐
         │ BriefingService  PlanningService  CalendarService          │
         │ ConflictService  GoalIntelligence FocusInsights  DayPlanner│
         └───────────────────────────┬───────────────────────────────┘
                                     ▼
                       IntelligenceService::snapshot()      (deterministic, per request)
                   ┌─────────────┬───────────┴──────────┬────────────────────┐
                   ▼             ▼                      ▼                    ▼
         MorningIntelligence  RecommendationService  WeeklyIntelligence   DayPlanner (strategy, interruption)
          GET …/briefing      GET/POST recommendations  GET reviews/{w}     GET/POST day-plan
                                     │ act                    │ narrative (opt-in, numbers only)
                                     ▼                        ▼
                         AssistantActions proposal     AI provider ──fail──▶ rule-based summary
                         (pending → approve → undo)
```

## What is rule-based versus powered by an external AI model

| Feature | How it works | External AI model? |
|---|---|---|
| Priority scores, reasons, risk, confidence and sources | Deterministic rules (`BriefingService` scoring + `IntelligenceService`) | **No** |
| Deadline risk, workload, conflicts, focus windows, focus capacity | Deterministic calculations over the calendar, tasks and focus history | **No** |
| Goal and habit attention, unfinished and postponed work | Deterministic rules (`GoalIntelligence`, postponement counter) | **No** |
| Morning intelligence briefing and its "improvements" | Rule-based composition of the snapshot | **No** |
| Proactive suggestions (all six types), deduplication, tuning | Rule-based (`RecommendationService`); tuning counts the user's ratings | **No** |
| Planner strategies, interruption re-planning, explanations | Deterministic `DayPlanner` | **No** |
| Weekly facts, interpretations, suggestions | Measured facts + a fixed rule set, labelled "rule-based" in the UI | **No** |
| Weekly summary ("Summarise my week") | Rule-based text by default. **AI-written only if** `features.ai_narrative` and `assistant_external` are on and a provider is configured; it receives numbers only. Falls back to rule-based on any failure. The UI labels which one was used. | **Optional, opt-in** |
| Copilot chat (pre-existing, unchanged) | Local assistant, or the external provider when `assistant_external` is allowed (connected details only with `ai_connected_data`) | Pre-existing, opt-in |

**Verified in code before commit:**
- The V9 services and controller contain no calendar write-back, no provider HTTP calls and no task or event writes.
- They write only the user's AI preferences and recommendation records, and delete data only on explicit request.
- "Act" only creates a pending proposal.
- The single external-AI call is `WeeklyIntelligence::narrative`.

## AI data flow and privacy model
- **Local by default.**
  - Insights, recommendations, the briefing, planner strategies and weekly interpretations are computed on the LifeOS server.
  - No AI provider is called for them.
- **Data-source permissions:** `calendar`, `connected`, `goals`, `habits`, `focus`, `checkins`.
  - A disabled source is not read by the engine (tests cover connected calendars, goals and the whole calendar).
  - Tasks are always used.
- **External AI, one use only:** the weekly summary. It requires all three of:
  - `features.ai_narrative` (off by default);
  - the existing `assistant_external` consent;
  - a configured provider.

  It sends **only numeric facts** (e.g. `focus_minutes`, `on_time_rate`) and the keys of the triggered observations — never titles, events or notes (tested). Failures fall back to a deterministic summary labelled "rule-based".
- **No profiling:** no personality, mood, health or other sensitive characteristics are inferred or stored. Confidence describes data volume, not the person.
- **What is stored:** recommendations (situation key, type, text, evidence, the user's rating, status) and Copilot proposals. Retention is 30/90/180 days, pruned hourly. "Delete AI data" removes both; the security audit log of applied changes is kept.
- **Personalization (opt-in):** after three or more "not useful" ratings that outnumber "useful", a suggestion type is shown less (high-severity ones still show). It can be reset at any time.
- **No autonomous actions:**
  - Acting on a suggestion creates a pending proposal; applying it goes through the existing re-validated approval, and undo.
  - Sync, the scheduler and the hourly `lifeos:recommendations` job never change tasks or events and never write to external calendars (tested).
- **Notifications:** "In-app only" by default. "Daily digest" sends at most one notification per day (per-user dedupe key), honouring notification channels and quiet hours.

## API (all authenticated, scoped to the signed-in user)

| Method & path | Purpose |
|---|---|
| `GET /api/intelligence/briefing` | Morning intelligence (`{enabled:false}` when off) |
| `GET /api/recommendations` | Active suggestions (refreshes; respects frequency and opt-in tuning) |
| `POST /api/recommendations/{id}/dismiss` | `{snooze_days?: 1\|3\|7}` — dismiss permanently, or snooze |
| `POST /api/recommendations/{id}/feedback` | `{useful: bool}` |
| `POST /api/recommendations/{id}/act` | Creates a **pending** Copilot proposal (422 for link-only suggestions) |
| `GET / PUT /api/intelligence/settings` | AI preferences (strict validation); GET also returns external-AI status and stored counts |
| `GET /api/intelligence/activity` | Proposals, suggestion history and AI audit events (safe fields only) |
| `POST /api/intelligence/reset-personalization` | Clears stored ratings |
| `DELETE /api/intelligence/data` | Deletes recommendations and Copilot proposals |
| `GET /api/reviews/{week}` | Now includes `intelligence` (facts, interpretations, workload, suggestions) |
| `POST /api/reviews/{week}/narrative` | Weekly summary: `{kind: ai\|rules, text, provider?, fallback_reason?}` (`throttle:assistant`) |
| `GET /api/day-plan` / `POST /api/day-plan` | Accept `busy_until` (`H:i`) and `lost_minutes` (0–600); new variant `deadlines` |

- **Schema:** migration `add_personal_intelligence` adds `tasks.postponed_count` and `tasks.last_postponed_at`, plus the new `recommendations` table.
- **Postponement counting:**
  - A deadline moved later by more than an hour counts.
  - A first deadline, moving earlier, or a removal does not.
  - The next recurring occurrence starts at 0.

## Testing and verification matrix

| Area | Automated coverage |
|---|---|
| Priority scoring and explanations | `PersonalIntelligenceTest`: ordering, reasons (overdue, deadline_risk, postponed), score 0–100, risk, confidence, sources |
| Calendar and timezone edge cases | Pacific/Auckland near midnight (local day, no windows left, deadlines); deadline risk around a 6 h workshop; existing V6/V7 DST suites |
| Focus capacity | no history → low confidence; 12 sessions/6 days → high, typical ×1.2; user's daily limit wins |
| Consent and data sources | connected/goals/calendar permissions; briefing off; AI narrative needs feature + `assistant_external` + provider |
| Multi-user isolation | other users' tasks absent; foreign recommendations 404 on dismiss/act/feedback; activity and deletion scoped |
| Approval-gated actions | act → pending proposal with no data change → apply → undo; link suggestions can't act; chosen day plan stays pending |
| Deduplication | repeated refreshes keep 6 rows; dismissed never return; snoozed hidden; resolved when handled; one digest per day |
| Feedback and privacy | opt-in quieting, reset, retention pruning (hourly job), delete AI data keeps work data, strict settings validation, audit |
| AI-provider failure and fallback | provider 529 → rule-based summary with `provider_error`; success → labelled AI; only numbers sent |
| Planner | deadlines-first ordering, `busy_until` / `lost_minutes`, validation, preferred strategy, choose with interruption |
| Arabic/English UI | Vitest `v9.test.tsx` (8); Playwright Arabic RTL Control Center; all components bilingual |
| Browser journeys | Playwright `intelligence.spec.ts` (3 journeys × desktop + mobile) plus `/settings/ai` in the smoke tour; the existing V8 specs still pass |

- **Results:**
  - **Backend:** 222/222 (1867 assertions) on SQLite and PostgreSQL 16.
  - **Frontend:** 92/92 Vitest (one existing dashboard test updated for the new default widget order).
  - **Playwright:** 18/18 (9 specs × desktop and mobile, including the 3 new V9 journeys).
  - TypeScript, ESLint (0 errors, 1 pre-existing warning), build, `npm audit --omit=dev` (0) and `composer audit` (none) — see the final report.
- **Manual visual check** with demo data: EN light 1440, AR dark 390 (reduced motion), EN dark 820 — no overflow, no console errors, no external requests.
  - Fixed during QA: the "Why?" toggle layout, and the briefing header wrapping its settings button at 820 px.

## Known limitations (V9)
- **Heuristic thresholds:** scores, thresholds (48 h deadlines, 100% overload, 3 "not useful" ratings, 3 idle days) and confidence levels are documented and tested, but not tuned on real usage data.
- **Focus capacity** uses focus sessions only; time tracked outside LifeOS is invisible.
- **Postponements** are counted from V9 on; earlier history is unknown.
- **Weekly interpretations** are a fixed rule set (focus trend, busiest-day focus, deadline slippage, estimate overruns, plan follow-through, strong habits). They are observational ("may"), never causal.
- **AI summary not verified live:** it has only been tested against a simulated provider. Real-provider wording quality is NOT VERIFIED.
- **Delivery:** recommendations refresh on page load and hourly for daily digests; there is no real-time push for new situations.
- **Server language:** recommendation texts are bilingual on the server; their date and time formatting uses the server's locale data.

## Next-phase roadmap (proposal)
- Calibrate thresholds with opt-in, aggregate, on-device statistics (no raw data leaving the server).
- Recommendation actions for goals (generate a goal plan proposal directly) and for conflicts (pre-filled move preview).
- An "explain this plan" view comparing strategies side by side.
- Optional AI rewording of individual suggestions with the same consent model and fallback.
- Live verification of the AI summary with a real provider account.

# V10 — AI Copilot 4.0 and intelligent conversations

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (b1c9efe) after PR #8 (V9) was merged. Merged into `main` as PR #9.

- **Copilot is now conversational:** multi-turn conversations with stored history, clarifying questions, deterministic follow-ups and multi-step planning (a week, priorities, focus blocks, a day after an interruption).
- **Every change is still a proposal.** Plans become the existing pending proposals (preview, partial approval, re-validation at apply time, 24-hour undo). Saying "yes" in chat never applies anything, and nothing is written to Google or Outlook.
- **External AI is optional.** Without a configured provider, or with `assistant_external` off, the local rule-based assistant handles all of the above. With a provider, the model only interprets the request; the server computes every plan, validates every field and every ID, and falls back to the local assistant on any failure.

## Phase 0 — Audit (findings that shaped V10)

| Area | Finding before V10 | V10 response |
|---|---|---|
| Copilot | Single-turn; turns lived only in browser state; no clarification | Stored conversations (`conversations`, `conversation_messages`), clarifications, follow-ups |
| External context | Always sent tasks, the 7-day agenda, goals, projects, habits and stats, whatever the question; V9 source switches were ignored | `CopilotContext`: minimal sections by relevance, V9 source permissions applied, connected titles masked without `ai_connected_data` |
| Untrusted text | Titles were sent verbatim (control characters, bidi overrides, newlines) | `CopilotContext::clean()` strips them and caps length at 120 characters; the prompt states that all input is data |
| Returned IDs | Provider-supplied task/goal/project IDs relied on downstream scoping | `AssistantService::authorizedIds()` drops any ID not in the context that was shared |
| Retries | A retried request could run twice | `client_id` idempotency per user (unique index); a replay returns the stored answer |
| Planning | `PlanningService::generate()` stored a schedule proposal as a side effect; no week, focus-block, priority or interruption plans for Copilot | `PlanningService::compute()` (no side effect) and `CopilotPlanner` |
| Streaming | None | SSE with real processing stages; the answer arrives only after server-side validation |

Reused rather than duplicated: `PlanningService` (week planning, windows, free intervals), `DayPlanner` (interruptions and variants), `CalendarService::occurrences` (all commitments, connected included), `BriefingService::rank`, `IntelligenceService` (workload), `AssistantActions` (store, apply, partial apply, revalidate, undo, dismiss), `IntelligenceSettings` (permissions, retention, personalization) and `AuditLogger`.

## Module status

| Phase | Module | Status |
|---|---|---|
| 1 | Conversation engine (`ConversationService`, `CopilotController`) | Done: history, deletion, rename, clarification, follow-ups, alternatives, idempotency, approval guard, SSE |
| 1 | Provider abstraction | Reused `AiProvider` (Anthropic/OpenAI, timeout `AI_TIMEOUT`); schema extended with planning slots and `clarify`; any failure → local fallback with a notice |
| 2 | Context-aware intelligence (`CopilotContext`) | Done: tasks always (25, ranked); calendar, goals, projects, habits, focus and workload only when relevant and allowed |
| 3 | Multi-step planning (`CopilotPlanner`) | Done: `plan_week`, `prioritize`, `focus_blocks`, `reorganize_day`, each with explanation, conflicts, alternatives and expected impact |
| 4 | Approval-gated execution | Done by reuse: `AssistantActions::proposeBlocks()` → pending proposal (preview, partial approval, re-validation, undo); proposals link to their conversation |
| 5 | Conversational workspace (`AssistantPage`, `PlanCard`, `lib/copilot.ts`) | Done: sidebar/drawer history, streaming stage indicator, plan/clarification/proposal cards, data-source chips, AI vs rule-based labels, RTL/LTR, responsive |
| 6 | Personalization | Done: opt-in `conversation_personalization` (suggested prompts ranked by the user's own request kinds since the last reset); retention, inspection and deletion |
| 7 | Security | Done: see the security section below |
| 8 | Testing | Done: see the matrix below |
| 9 | Documentation | This section |

## Architecture

```
AssistantPage (React)
  └─ lib/copilot.ts  sendCopilot(): POST /api/copilot/messages  (Accept: text/event-stream → SSE, else JSON)
        │
CopilotController::message ── throttle:assistant (AI_REQUESTS_PER_MINUTE, default 10/min/user)
  └─ ConversationService::send(user, conversation?, text, language, client_id?, choice?, progress)
        ├─ replay(client_id)            → stored answer (idempotent)
        ├─ choice (option | alternative) → validated against what that message offered → CopilotPlanner::run
        ├─ approval words ("yes, apply") → approvalGuard (never applies; points to the Apply button)
        ├─ followUp(previous state)      → deterministic slot changes → CopilotPlanner::run
        └─ AssistantService::respond(user, text, language, history, progress)
              ├─ external(): CopilotContext::build → AiProvider::json(schema) → Validator → authorizedIds
              │     ├─ planning intents → CopilotPlanner::run (server computes the plan)
              │     └─ existing intents (schedule, query, explain, triage, find_time, plan_day, …)
              └─ local(): intentOf() keyword router (EN/AR) → same handlers
CopilotPlanner
  ├─ planWeek / prioritize → PlanningService::compute (no persistence)
  ├─ focusBlocks           → free intervals around every occurrence (+ break buffers), one per day first
  └─ reorganizeDay         → DayPlanner::plan(replan, interruption) and its variants
  └─ AssistantActions::proposeBlocks → AssistantProposal (pending, create_event actions a1..aN)
```

- **Message storage:** `conversation_messages.payload` keeps the structured answer (`plan`, `clarify`, `state`, `proposal`, `context`, `items`, `tasks`, `subtasks`, `notice`). When a conversation is opened, proposals are re-read so each card shows its current status (pending, applied, undone, dismissed, expired).
- **Conversation state:** each planning answer stores `state = {intent, slots, awaiting?}`.
  - A clarification fills the awaited slot.
  - A follow-up changes slots ("make them 90 minutes", "next week instead", "essentials only", "tomorrow").
  - An alternative re-runs the plan with another variant.
  - A replaced plan's pending proposal is dismissed, so only the current version can be applied.
- **Streaming:** the stages are real server steps (`received`, `context`, `provider`, `validating`, `planning`, `fallback`, `saving`). Model tokens are deliberately not streamed: output must pass validation before the user sees it.

## Conversation and tool data flow

1. The user sends text, or picks an option or alternative. The browser adds a random `client_id`.
2. The server stores the user message first; a duplicate `client_id` returns the earlier answer.
3. Deterministic paths (choice, approval guard, follow-up) never call the provider.
4. Otherwise the external provider, if allowed, gets:
   - the system rules;
   - the request;
   - the last 6 turns — the user's own words, and earlier answers only by kind, e.g. `(answered: focus_blocks)`;
   - the minimal context.
5. It returns JSON constrained by a closed schema.
6. The server validates it: intent enum, dates within 14 days, `count` 1–6, `minutes` 30–180, priorities from a fixed list, ≤4 clarification options of ≤80 characters.
7. It drops unauthorized IDs and computes all times itself from the real calendar.
8. Planning results are stored as **pending** proposals. Nothing touches tasks, events or connected calendars until the user presses Apply on chosen items, which re-validates them (`AssistantActions::apply`); undo works for 24 hours.

## AI privacy and consent model

| Data | Local assistant | External provider (only if `assistant_external` is on and a provider is configured) |
|---|---|---|
| Request text | Used on the server | Sent |
| Earlier turns | Used for follow-ups | User turns (cleaned, ≤500 characters) and the kinds of earlier answers; never earlier answer text |
| Tasks | Used | Top 25 open tasks: title (cleaned), priority, status, estimate, due date. Tasks imported from other apps live in `external_tasks` and are not sent |
| Calendar (7 days, ≤40) | Used | Only if the question needs it **and** the `calendar` source is on; connected events only if `connected` is on, shown as "Busy" without `ai_connected_data` |
| Goals / habits / focus totals | Used when relevant | Only if relevant **and** that source is allowed |
| Projects / workload | Used when relevant | Only if relevant |

- **Visibility:** every answer shows its data sources: "Shared with Claude: …" or "Used on this server: …", including how many connected events were masked.
- **Labels:** each answer is labelled "AI · Claude/OpenAI" or "Rule-based · Local assistant".
- **Retention:** conversations follow the V9 retention period (30/90/180 days, pruned hourly by `lifeos:recommendations`).
  - Conversations can be deleted one by one or all at once.
  - "Delete AI data" in the AI Control Center also deletes them.
  - The demo reset removes them.
- **No hidden profiling:** conversation personalization is off by default.
  - When on, it only counts the user's own request kinds since `conversation_reset_at` to order suggested prompts.
  - "Reset personalization" restarts it.
  - Nothing else is inferred or stored.

## API (authenticated, scoped to the signed-in user)

| Endpoint | Purpose |
|---|---|
| `GET /api/copilot/conversations?language=en\|ar` | `{conversations, suggestions, personalization, retention_days}` |
| `GET /api/copilot/conversations/{uuid}` | `{conversation, messages}`; proposals refreshed to their current state |
| `PATCH /api/copilot/conversations/{uuid}` | `{title}` (≤120) |
| `DELETE /api/copilot/conversations/{uuid}` | Delete one (audited as `conversation_deleted`) |
| `DELETE /api/copilot/conversations` | Delete all (audited) |
| `POST /api/copilot/messages` | `{conversation_id?, message?, language, client_id?, choice?: {type: option\|alternative, message_id, value}}` → `{conversation, user_message, message, replayed}`. With `Accept: text/event-stream`: `stage` events, then `done` (same payload) or `error` `{status, message}`. `throttle:assistant` |
| `POST /api/assistant` | Unchanged single-turn endpoint (kept for compatibility); now also uses the minimal context and the new intents |

- **Schema:** migration `2026_10_25_100954_add_copilot_conversations` is additive and reversible (rollback verified on PostgreSQL 16).
  - New tables `conversations` (uuid) and `conversation_messages`, with a unique `(user_id, client_id)`.
  - A nullable `assistant_proposals.conversation_id`.
- **Configuration:** new `AI_REQUESTS_PER_MINUTE` (default 10). The browser-test server sets 200; nothing else changes.

## Security review (Phase 7)

| Risk | Mitigation | Test |
|---|---|---|
| Prompt injection from imported/connected titles | Titles cleaned (control/bidi characters, newlines, length); prompt marks all input as untrusted data; the model can only choose an intent and slots — the server computes and validates everything | `test_external_context_is_minimal_permission_aware_and_treated_as_untrusted` |
| Excessive context disclosure | Relevance-based sections, V9 source permissions, masking, earlier answers never resent | same test (no habits/goals, calendar off ⇒ no events, masked count) |
| Cross-user exposure | Every query scoped by `user_id`; conversations 404 for other users; choices must reference a message in the caller's own conversation | `test_conversations_are_private_to_their_owner` |
| Unauthorized tool execution | No tool runs from chat; approval words are intercepted; plans are pending proposals applied only via the existing apply endpoint with re-validation | `test_agreeing_in_chat_never_applies_a_proposal`, partial apply/undo test |
| Hallucinated or planted IDs | Dropped unless they were in the shared context | Existing V5/V7 tests (999999, foreign project) and the V10 test (foreign task id) |
| Duplicate/replayed actions | `client_id` idempotency; replaced plans' proposals dismissed; proposals apply once (existing) | `test_retried_messages_are_answered_once`, follow-up test |
| Provider failure / malformed output | Closed schema + server validation; any exception → local assistant with a notice | `test_malformed_or_failing_provider_output_falls_back_to_local` |
| Abuse | `throttle:assistant` on messages; input ≤4000 characters; titles ≤120; `client_id` pattern | validation tests |

## Testing and verification matrix

| Area | Coverage |
|---|---|
| Conversations, history, rename, deletion, retention, Delete AI data | `ConversationTest` (16 tests) |
| Clarification and options; follow-ups; alternatives | prioritize/reorganize clarifications, "make them 90 minutes", alternative `short`, invalid option/alternative → 422 |
| Planning | week plan never overlaps a fixed meeting and writes nothing; focus blocks spread across days, avoid a lecture, partial apply + undo |
| Consent, minimal context, prompt injection, isolation, idempotency, approval guard, fallback | see the security table |
| Streaming | SSE stage order, `done` payload, streamed 404 |
| Arabic | Arabic planning requests (backend); Arabic workspace (Vitest); RTL journey with mobile drawer (Playwright) |
| Frontend units | `v10.test.tsx` (9): SSE parser and client, plan card, AI/rule labels and shared-data chips, history, alternatives, clarification choice, delete confirmation, Arabic |
| Browser journeys | `conversation.spec.ts` (3 journeys × desktop + mobile): plan → follow-up → refused chat approval → partial apply → undo → history after reload → delete; clarification + alternative; Arabic RTL with mobile history drawer |

- **Results:**
  - **Backend:** 238/238 on SQLite and PostgreSQL 16.
  - **Frontend:** 101/101 Vitest.
  - **Playwright:** 24/24 (12 tests × desktop + mobile).
  - Also clean: `tsc -b`, ESLint (0 errors; 1 pre-existing warning), production build, `npm audit --omit=dev` (0) and `composer audit` (none).
- **Manual visual check** with demo data (EN desktop 1440 light, AR Pixel 7 dark): no horizontal overflow, no console errors besides the expected 401 on the login page. Fixed during QA: a long Arabic conversation title overflowed the chat panel on mobile (grid `min-width`).
- **Known flaky test (unrelated to V10):** the Vitest "notification center › shows the unread badge and marks everything read" test failed once under full-suite load, then passed on every rerun (alone and in the full suite). It is timing-sensitive and was not changed in V10.
- **Browser-test fix:** the V8 `copilot.spec.ts` check failed once on a pre-commit run (13 events after undo instead of 12) and passed 3/3 alone.
  - **Cause:** the test counted events in a window from "now" to "now + 3 days", recomputed on every count, and demo events are seeded relative to the run's start time, so one could slide into the window mid-test.
  - **Fix:** both Copilot specs now use one fixed window per run. Product code is unaffected.
- **Simulated versus live:** all external-provider behavior was tested against a **simulated** Anthropic API (`Http::fake`); browser tests run with `AI_PROVIDER=disabled` and block every non-local request.
  - Live model behavior is **NOT VERIFIED**: intent and slot quality, Arabic wording, clarification quality and latency.

## Known limitations (V10)
- **Local router:** the rule-based assistant recognises planning requests by keywords (EN/AR). Unusual phrasings fall back to general help, or to the provider when allowed.
- **Follow-ups** are deterministic for planning answers only (length, count, week, day, priorities, version). Other follow-ups rely on the provider, which sees earlier answers only by kind.
- **Plans only add blocks.** Moving existing flexible events stays with the existing rebalance proposal, and fixed appointments never move.
- **Focus blocks** use working hours (and focus hours when set), not study or personal windows.
- **Proposal size:** week plans show at most 30 blocks per proposal.
- **No token streaming:** streaming shows stages, not partial model text.
- **No editing:** conversations cannot be branched or edited after sending.
- **Retention granularity:** retention is per conversation, by last activity.
- **Rate limit:** the default (10 messages per minute per user) can be reached by fast clicking through alternatives; configurable with `AI_REQUESTS_PER_MINUTE`.

## V11 roadmap (proposal)
- Live verification with real Anthropic/OpenAI accounts: intent accuracy, Arabic quality, latency budget.
- Plans that also propose moving flexible events (with the V7 move preview) inside the same conversation.
- Study/personal-window focus blocks and per-area capacity limits.
- Conversation search and export; pinning a plan as a template for future weeks.
- Proactive suggestions (V9) that open a pre-filled Copilot conversation.
- Opt-in, explainable learning of preferred plan variants (same reset and deletion controls).

# V11 — Copilot plans that move flexible events

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (2dc8ebc) after PR #9 (V10) was merged. Merged into `main` as PR #10.

Scope chosen for V11 (from the V10 roadmap): Copilot plans may also propose **moving** existing flexible LifeOS events, with the V7 conflict preview. The other roadmap items are not part of this release:
- live provider verification (needs your API key and authorization);
- study and personal windows for focus blocks;
- search, export and templates;
- suggestions that open Copilot, and learned plan variants.

## What changed
- **Week plans and priority plans** (`plan_week`, `prioritize`): when a day in the week is at least 90% booked, the plan includes moves of flexible blocks to lighter work days. The same algorithm as the existing "rebalance" proposal is reused through `AssistantActions::rebalanceMoves()`.
- **Reorganizing after an interruption** (`reorganize_day` with "busy until"): flexible blocks the interruption now overlaps (from now until busy-until, today) move to the first free slot later that day, otherwise to the next work days within a week.
- **One proposal holds both.** Moves come first, then new blocks.
  - New blocks are planned around where moved events land: `reserved` time is passed to `PlanningService::compute()` and `DayPlanner::plan()`.
  - New blocks never reuse the time a move frees.
  - So every action is independent, and approving any subset is safe.
- **Preview on each move:**
  - each move action carries a `reason` and a `conflicts` preview from `TimelineService::preview` (the V7 move preview);
  - the proposal card shows "Moves an existing block", the from→to times, the reason, and "No conflicts at the new time" (or what it overlaps);
  - the plan card says how many blocks move and offers "Keep everything in place" / "Move flexible blocks if needed".
- **Opting out:**
  - In words: "don't move anything", "keep everything in place", "لا تنقل أي شيء" — as a follow-up or in the original request.
  - Through the plan-card switch (choice `moves:off` / `moves:on`).
  - Through the provider schema field `plan.moves = false`.
  - "Without moving fixed appointments" does not count, since fixed appointments never move anyway.

## What can never move
`AssistantActions::movable()` decides at planning time and `execute()` re-checks at apply time:

| Event | Moves? |
|---|---|
| Fixed appointments (`kind = fixed`) | Never (planning + apply) |
| Recurring series | Never (planning + apply) |
| Connected-calendar events (Google, Outlook, ICS) | Never; they are not LifeOS events |
| LifeOS events copied to a connected calendar (V8 write-back link) | Never (planning + apply, new in V11). Moving them locally would make the copy stale, and LifeOS never writes to connected calendars on its own |
| Events starting within 5 minutes or in the past | Not proposed |
| Flexible, non-recurring, future LifeOS events you own | Proposed; moved only after you apply, and only if unchanged since the proposal and the new time is still free |

- **Apply** re-checks ownership, kind, recurrence, write-back links, "unchanged since the suggestion", and that the new time is free. Any failure refuses the whole apply with a clear message.
- **Undo** puts an event back only if it is still exactly where the plan left it and its original time is still free.
- At most 10 moves per proposal.

The existing V5 "rebalance" proposal now uses the same rules, so it also stops moving written-back events.

## Testing
- **Backend:** `MovePlanningTest` (7 tests).
  - The week plan moves only the flexible block; fixed, recurring, written-back and connected events stay. Moves come first with a preview and reason. New blocks avoid the destination and don't reuse the freed time.
  - A move applies alone and undoes, with no request to Google.
  - Apply refuses a move that became unsafe (copied to a calendar since, or made fixed).
  - Keep-in-place works by follow-up, by choice and in the original request; invalid choices return 422.
  - An interruption moves a caught block after "busy until" and never moves a fixed appointment.
  - Rebalance ignores written-back events.
  - The provider can set `plan.moves = false`.
- **Vitest:** `v11.test.tsx` (4) covers the moves row and its switch, the move preview (reason, conflict check, overlaps), and the mixed "Apply N change(s)" label sending only the chosen ids.
- **Playwright:** `moves.spec.ts`, desktop and mobile.
  - It builds a fully booked day without overlaps: every free gap gets a fixed appointment, and the largest gets a flexible block.
  - It asks for a week plan, checks that fixed appointments are not in the moves, and applies only the first move. It then verifies the event in the database, undoes, and confirms that "Keep everything in place" removes the moves.
- **Results:**
  - **Backend:** 245/245 on SQLite and PostgreSQL 16.
  - **Frontend:** Vitest 105/105.
  - **Playwright:** 26/26.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning), build, `npm audit --omit=dev` (0) and `composer audit` (none).
- **Manual check** with demo data (EN desktop 1440, AR Pixel 7 dark): the plan shows 1 move with its reason and conflict check; no overflow, no console errors besides the expected 401 on the login page.
- **Simulated versus live:** the provider path (`plan.moves`) was tested only against a simulated Anthropic API. Live behavior is **NOT VERIFIED**.

## Known limitations (V11)
- **Interruptions:** only "busy until" triggers moves; "time lost" alone shrinks capacity but moves nothing.
- **Freed time:** the time a move frees is not used for new blocks in the same proposal. Ask again after applying to use it.
- **Overload warnings:** the plan's "Needs your attention" list is computed from the current calendar, so a day can still show as overloaded although the plan moves a block off it.
- **Where moves go:** destinations use working hours for week plans, and all of that day's windows (work, study, personal) for interruptions; moves never go to days outside the plan's week.
- **Focus blocks** never move anything; they only use free time.
- **Language at page load:** if a message is sent within about a second of the page loading, the language the app had before switching (e.g. the previous session's) can still be used for that one reply. This is existing behavior, seen during manual QA.

# V12 — Study and personal focus with per-area daily limits

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (9495f6d) after PR #10 (V11) was merged. Merged into `main` as PR #11 (with a CI fix: `API_REQUESTS_PER_MINUTE`, default 300, raised only for the isolated browser-test server).

Scope (from the V10 roadmap): focus blocks and plans use your study and personal windows too, with an optional daily limit per area.

## What changed
- **Week planner (`PlanningService::compute`)** — used by Smart planning and Copilot's week and priority plans.
  - Before V12, every task was planned in working hours. Now a task whose category area is Study or Personal goes into that window, when you have set one (Plan my day → Boundaries).
  - Without the window, it keeps using working hours, exactly as before.
  - Items record the area they were placed in, and acceptance re-validates them against that window.
  - The day load in the summary is measured against working hours only, so study and personal blocks no longer count towards it.
- **Per-area daily limits:**
  - New settings `study_daily_limit` and `personal_daily_limit` (15–900 minutes, empty means no limit), on the Boundaries form.
  - The week planner applies them per day.
  - The day planner applies them on top of the overall budget.
  - Copilot focus blocks count blocks already booked in that window towards the limit.
  - The existing daily focus limit still governs working hours (and the whole day in the day planner).
- **Copilot focus blocks** (`CopilotPlanner::focusBlocks`):
  - **Choosing the area:** the request can name one ("study blocks", "personal projects", "للدراسة"), the provider can set `plan.area`, or a follow-up can change it ("use my study hours instead").
  - **No area named:** blocks use working hours, then study hours. Personal time is used only when asked.
  - **Area named but no window set:** working hours are used and a "No study hours set" notice explains where to set them.
  - **Labels:** blocks read "Study: Exam revision" / "Personal: …". A large task keeps filling blocks while it has unassigned estimated time.
  - **Switching:** the plan offers "In working hours / In study hours / In personal time" alternatives when windows exist.
- **Fixed along the way:** day-plan items recorded the task's area even when the task was placed in working hours (no study window that day), so accepting such a plan failed with "Availability changed". Items now record the area actually used.
- **Local router:** "study block(s)", "study session(s)", "personal block" and the Arabic equivalents now count as focus-block requests.

## Testing
- **Backend:** `AreaFocusTest` (6 tests).
  - Study tasks land in study hours, at most the daily limit per day, and the plan is accepted.
  - Without study hours, study tasks use working hours, as before.
  - The day planner respects the study limit, and a plan placed in working hours is accepted (the fix above).
  - Copilot study blocks respect the limit including an already-booked block, are labelled "Study: …", switch to working hours by choice and back by follow-up.
  - Personal focus without a window falls back with a notice.
  - Arabic study request.
  - Settings validation.
- **Vitest:** `v11-12.test.tsx` (+2) covers the Boundaries form saving the limits (empty means none), and the area switch on a focus plan.
- **Results:**
  - **Backend:** 251/251 on SQLite (three consecutive runs) and PostgreSQL 16.
  - **Frontend:** Vitest 107/107.
  - **Playwright:** 26/26 (no new browser journey; the demo account has no study hours).
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning), build, `npm audit --omit=dev` (0) and `composer audit` (none).
- **Live AI:** the provider's `plan.area` field was tested only against a simulated API. Live behavior is **NOT VERIFIED**.

## Known limitations (V12)
- **Areas come from task categories:** uncategorised tasks count as work.
- **One window per area per day,** shared by all days; no per-weekday study hours.
- **Personal time** is used for focus blocks only when asked, and is never used by week plans for work tasks.
- **Day load** in the week summary covers working hours only; study and personal load are not shown separately yet.
- **Copilot focus-block limits** count existing task blocks only (not other events) towards an area's limit.

# V13 — Conversation search, export and week-plan templates

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (f274829) after PR #11 (V12) was merged. Merged into `main` as PR #12.

## What changed
- **Search:**
  - The Copilot sidebar has a search box. `GET /api/copilot/conversations?q=` matches the user's own conversation titles and message text, case-insensitively.
  - `%` and `_` are taken literally, and queries are limited to 100 characters.
  - Each result shows a snippet of the first matching message.
- **Export:**
  - `GET /api/copilot/conversations/{id}/export?format=md|json` downloads one conversation as an attachment.
  - **Markdown** contains every message, labelled You or Copilot (rule-based / AI · provider), each plan's explanation and conflicts, and each proposal's changes with their current status.
  - **JSON** has the same messages as the API, without client ids.
  - Each export is recorded in the AI activity (`conversation_exported`).
  - The links sit in the chat header of an open conversation.
- **Week templates:**
  - **Save:** "Save as template" on any proposal that adds blocks (`POST /api/copilot/templates {proposal_id, name, action_ids?}`).
    - Each new block is stored as ISO weekday, local start time, length, title and task link. Moves are not stored.
    - At most 30 blocks per template and 50 templates per user. Recorded as `plan_template_saved`.
  - **Use:** from the sidebar ("Plan next week from …") or in words ("Plan next week from my template Deep week", Arabic «قالب»).
    - Copilot creates a normal pending proposal (`kind = template`), with the same preview, partial approval, re-validation at apply time and undo.
    - Blocks that are already past or would clash with anything in the calendar are left out and listed; nothing existing moves.
    - Task links are kept only for tasks that are still open.
  - **Options:** the plan offers "This week / Next week". With several templates and none named, Copilot asks which one. Templates can be renamed and deleted (`PATCH` / `DELETE /api/copilot/templates/{id}`).
- **Schema:** migration `add_plan_templates` creates the `plan_templates` table. It is additive, and rollback was verified on PostgreSQL 16. The demo reset removes templates.
- **Privacy:**
  - Search, export and templates only ever read the signed-in user's data, and nothing is sent to a provider.
  - Templates are things you saved yourself, so "Delete AI data" keeps them; delete them in the sidebar.

## Testing
- **Backend:** `CopilotLibraryTest` (5 tests).
  - Search covers titles and messages, the snippet, a literal `%`, other users' conversations never appearing, and the 100-character limit.
  - Markdown and JSON export check the headers, contents and audit entry; an unknown format returns 422 and another user gets 404.
  - Saving a template checks weekday/local time and the subset option; a proposal without new blocks returns 422, another user's proposal 404, and a name over the limit 422.
  - Using a template checks the same days and times next week, a clash with a fixed event being skipped, links only to open tasks, nothing written before approval, a partial apply, and that the this-week option skips past blocks.
  - Choosing between several templates, rename/delete isolation, and the no-templates reply.
- **Vitest:** `v13.test.tsx` (4) covers save-as-template (request and the sidebar refresh event), the template proposal label, search with snippet and export links, and planning from a template plus delete confirmation.
- **Playwright:** `library.spec.ts`, desktop and mobile.
  - Plan, save as template, export Markdown (headers and contents), plan next week from the template, search, clean up.
- **Results:**
  - **Backend:** 256/256 on SQLite and PostgreSQL 16.
  - **Frontend:** Vitest 111/111.
  - **Playwright:** 28/28.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning), build, `npm audit --omit=dev` (0) and `composer audit` (none).
- **Manual check** with demo data (EN desktop, AR Pixel 7 dark): no overflow, no console errors besides the expected 401 on the login page. Fixed during QA: the sidebar search box used the global label layout (icon on its own line); it now uses the existing `.search` style.
- **Live AI:** the provider path for `use_template` was tested only against a simulated API. Live behaviour is **NOT VERIFIED**.

## Known limitations (V13)
- **Search** uses a simple substring match: no ranking, no stemming, and Arabic diacritics must match exactly.
- **Export** covers one conversation at a time, in Markdown or JSON (no PDF), and proposals show their current status, not their history.
- **Templates** repeat the same weekdays and times. They don't adapt to a changed calendar beyond skipping clashing blocks, and there is no per-week variation or recurrence.
- **Templates are not managed in the AI Control Center;** they are listed and deleted in the Copilot sidebar.

# V14 — Suggestions to Copilot and plan learning

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (d99f467) after PR #12 (V13) was merged. Merged into `main` as PR #13.

## What changed
- **Ask Copilot from a suggestion.** Every proactive suggestion (V9) has an "Ask Copilot" button.
  - `POST /api/recommendations/{id}/discuss {language}` (`throttle:assistant`) starts a new conversation, through `ConversationService::seed`. It holds a question in your language and an answer from the existing planners:

    | Suggestion | Question | Answer |
    |---|---|---|
    | Deadline | "Find time for “X” before it’s due" | find-time proposal for that task |
    | Postponed task | "Help me finally get “X” done" | find-time proposal for that task |
    | Overloaded day | "My Wednesday is overloaded — plan my week around it" | week plan, which may move flexible blocks (V11) |
    | Focus window | "Find a focus block today for “X”" | one focus block today |
    | Goal | "Plan my goal X" | goal plan |
    | Conflict | "Do I have any conflicts?" | conflict check |

  - Any change is a pending proposal in that conversation.
  - A suggestion that produced a proposal is marked as acted on.
  - Recorded as `recommendation_discussed`.
- **Plan learning** (`PlanLearning`; opt-in feature `plan_learning`, off by default).
  - **What is counted:**
    - week plans: everything vs essentials;
    - focus-block length: 45 / usual / 90 minutes;
    - day strategy: balanced, deep, light, deadlines;
    - moving flexible blocks: allowed or kept in place.

    One counter per option is stored in `user_settings` and never sent to an AI provider.
  - **When it counts:** a counter goes up when you pick an alternative on a plan, change it by follow-up ("essentials only", "don't move anything"), or apply a plan (the applied version counts).
  - **Using it:** once one option has at least 3 observations and a share of at least 60%, it becomes the default for a fresh request. The plan says so ("Used what you usually choose: essentials only…") and carries `plan.learned`. The other versions stay one click away.
  - **What you say still wins:** explicit requests override learned defaults ("45-minute blocks", "keep everything in place", "essentials").
  - **Control:** the AI Control Center shows the counts and the current default per choice. "Forget learned preferences" (`DELETE /api/intelligence/learning`, audited as `plan_learning_reset`), "Reset personalization" and "Delete AI data" all clear them.
- **Rule change:** fresh requests no longer assume an explicit "balanced" / "moves on". Unstated choices are left empty and resolved as learned default, otherwise the previous default.

## Testing
- **Backend:** `PlanLearningTest` (5 tests).
  - Off by default: nothing recorded, no learned defaults.
  - The 3-choice threshold: two choices are not enough; after the third the default switches and is explained; switching back is learned.
  - Applied plans and follow-ups count, and explicit minutes override the learned length; a learned "keep in place" applies.
  - Inspect, forget (audited), reset and delete; invalid options are ignored.
  - Each suggestion type opens the right conversation: find-time proposal linked to the conversation, suggestion marked acted, nothing applied, Arabic conversation, goal plan, conflicts. An already-handled suggestion returns 422, another user's 404, and an invalid language 422.
- **Vitest:** `v14.test.tsx` (2) covers "Ask Copilot" (request and navigation to the conversation), and the Control Center learning summary, switch and forget.
- **Playwright:** `suggestions.spec.ts`, desktop and mobile.
  - It creates a task due tomorrow so a suggestion always exists, opens the first suggestion in Copilot (two messages, rule-based label, a pending proposal when present), then deletes the conversation and the task.
- **Results:**
  - **Backend:** 261/261 on SQLite and PostgreSQL 16.
  - **Frontend:** Vitest 113/113.
  - **Playwright:** 30/30, none skipped.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning), build, `npm audit --omit=dev` (0) and `composer audit` (none).
- **Manual check** with demo data (EN desktop, AR Pixel 7 dark): no overflow and no unexpected console errors. Fixed during QA: "Reset personalization" was disabled while only learned plan preferences existed.
- **Live AI:** learned defaults also apply to plans requested through an external provider, but that path was tested only against a simulated API. Live behaviour is **NOT VERIFIED**.

## Known limitations (V14)
- **Learning is per choice**, not per context: weekday, energy or workload are not considered.
- **Counts never decay;** a change of habit needs several new choices, or a reset.
- **"Ask Copilot" answers come from the local planners.** The external provider is not consulted for the seeded first answer; follow-up messages use it as usual.
- **Suggestions without a task or goal** (for example a conflict) open the general check rather than one about that specific item.

# V15 — Smarter plan learning

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (4317fd9) after PR #13 (V14) was merged. Merged into `main` as PR #14.

## What changed
- **Observations instead of counts.** `PlanLearning` now stores one small observation per choice: the choice, the option, the date and the situation. Situations:
  - `day`: workday or day off (only for one-day requests);
  - `load`: light, normal or heavy (the share of working hours already booked: below 35%, 35–69%, 70% or more).

  Nothing else is stored, and nothing is sent to an AI provider. At most 300 observations are kept.
- **Recent choices count more.** An observation's weight halves every 30 days, and observations older than 180 days are dropped.
  - A preference is used once its option was chosen at least 3 times and holds at least 60% of the weight.
  - Example: 3× "essentials" four months ago, then 3× "everything" now → "everything" (94%) is the default. Without weighting this would be a 50/50 tie.
- **Learned per situation.** Before planning, Copilot works out the request's situation (`PlanLearning::context`, only computed while learning is on). It looks for a clear preference in this order: same kind of day, then same load, then all observations.
  - Example: "deep focus first" on workdays and "light day" on days off are two separate defaults.
  - The plan says where a default came from: "Used what you usually choose: a light day (on days off)…". It also carries `plan.learned_context`.
- **Situation recorded with each choice.** Each plan's state carries `learning_context`, so a choice made on that plan (or applying it) is recorded for the situation the plan was made in.
- **Unchanged:** explicit requests and picking another version still win over learned defaults.
- **AI Control Center:**
  - per choice: counts with recent shares ("Essentials 3 (6% recent)"), the overall default, and situation defaults ("Days off: Light day", "Busy periods: Essentials");
  - a forget button per choice, `DELETE /api/intelligence/learning?dimension=…`, audited with the choice;
  - the hint explains the half-life and the 180-day limit.
- **Compatibility:** V14 counts are read as observations dated on the day they are first read, so they start to fade from then. They are rewritten in the new form on the next recorded choice. No migration and no schema change.

## Testing
- **Backend:** `SmarterLearningTest` (6 tests).
  - Recency: an old habit is overtaken by 3 recent choices but not by 2; recent shares are 6% / 94%; observations older than 180 days are dropped.
  - Day strategy per workday and day off: chat on Monday and on Saturday, with the explanation text; a choice on a day-off plan is recorded as a day-off choice.
  - Week version per busy and light week: a fully booked week gives essentials, an empty one balanced; picking another version still wins; the summary lists situation defaults.
  - No situation is computed or stored while learning is off.
  - V14 counts still work and are converted on the next choice.
  - Forgetting one choice: other choices are kept and the action is audited; an invalid choice name returns 422.
  - The V14 summary expectation now includes `shares` and `contexts`.
- **Vitest:** `v15.test.tsx` (2 tests): situation chips, recent shares, the hint text and the per-choice forget request, in English and Arabic.
- **Playwright:** `learning.spec.ts`, desktop and mobile.
  - It turns learning on, picks "Essentials only" three times, and checks that a fresh plan starts with essentials and says so.
  - The Control Center shows "Essentials 3 (100% recent)" and the default; the test forgets week plans only, then turns learning off and deletes its conversations.
- **Results:**
  - **Backend:** 267/267 on SQLite and PostgreSQL 16; Pint passes.
  - **Frontend:** Vitest 115/115.
  - **Playwright:** 32/32.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning) and build.
- **Manual check** with demo data and seeded observations (EN desktop, AR Pixel 7 dark): no overflow and no unexpected console errors. The demo learning was cleared afterwards.
- **Live AI:** situation-aware defaults also apply to plans requested through an external provider, but that path was tested only against a simulated API. Live behaviour is **NOT VERIFIED**.

## Known limitations (V15)
- **Fixed situations.** Only two are told apart: kind of day and booked share. Energy check-ins, time of year and individual weekdays are not used.
- **One situation at a time.** Situations are tried one after the other, not combined (no "busy days off").
- **Booked share counts calendar events in working hours only.** Study and personal windows and outstanding tasks do not make a period "busy".
- **Week plans never learn per day:** only their load is used.
- **Fixed thresholds.** The 30-day half-life and the 35% / 70% load bands cannot be changed in the app.

# V16 — Weekly plan drafts

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (eabfeca) after PR #14 (V15) was merged. Merged into `main` as PR #15.

## What changed
- **Weekly plan drafts** (`WeeklyDraftService`; opt-in, off by default). The user chooses:
  - a weekday;
  - a time (quarter-hour steps; the settings list offers half hours);
  - a source: a saved template, or the week planner with their preferences.
- **When it runs.** `lifeos:weekly-drafts` runs every 15 minutes. On the chosen day, at or after the chosen time, it prepares a draft of the coming Monday–Sunday week, once per week. Drafts also need the AI master switch on.
- **What a draft is.** A new Copilot conversation ("Draft next week’s plan (2 Nov – 8 Nov)") holding a **pending proposal**:
  - from the template (V13): blocks that clash or are past are left out;
  - or from the week planner (V11/V12): it may move flexible blocks;
  - learned defaults apply (V14/V15).

  The reply carries a notice: "Draft prepared on your schedule, … Nothing changes until you approve it." If the chosen template was deleted, the week planner is used and the notice says so.
- **Expiry.** Draft proposals stay open until the end of the planned Monday instead of 24 hours. Apply-time re-validation (V10) still checks every block against the calendar.
- **Notification.** One "planning" notification per week, "Next week’s plan draft is ready", linking to the conversation. It follows the category's in-app and push choices and quiet hours.
- **Nothing is written** to tasks, events or connected calendars.
- **Endpoints:**
  - `GET` / `PUT /api/copilot/weekly-draft`: settings. A template must be the user's own; the time must be `HH:00`, `HH:15`, `HH:30` or `HH:45`.
  - `POST /api/copilot/weekly-draft {language}`: "Prepare a draft now" (`throttle:assistant`). It opens the draft in Copilot, sends no notification and does not count as the scheduled draft.
- **Audit:** `weekly_draft_prepared` (week, scheduled or not, source, whether there is a proposal) and `weekly_draft_settings_changed`. Both are listed in the AI activity log.
- **AI Control Center:** under Planning preferences there is a switch, day, time and source selectors, "Prepare a draft now", and the week of the last scheduled draft.
- **Relation to the existing automation:** "Offer next week’s plan after the weekly review" (automation templates) is unchanged. It runs only when a review is completed and creates a Smart planning proposal. Weekly drafts run on a schedule, live in Copilot and use templates and learned preferences.

## Testing
- **Backend:** `WeeklyDraftTest` (5 tests).
  - Off by default: the schedule prepares nothing.
  - The schedule:
    - nothing before the chosen time; exactly one draft after it, even when run twice;
    - a pending proposal for next week only, open until Monday 23:59, with nothing written;
    - one planning notification linking to the conversation, and the audit details;
    - the next week is prepared on the next Sunday.
  - A template draft keeps the template's days and times; "prepare now" sends no notification and does not replace the scheduled draft; a deleted template falls back to the planner (Arabic conversation).
  - Learned week versions are used.
  - The AI switch stops drafts. Another user's template, an invalid weekday or time, and an unsupported language are rejected; changes are audited and listed in the activity log; signed-out requests are refused.
- **Vitest:** `v16.test.tsx` (3 tests): saving the switch, day, time and template; "Prepare a draft now" in Arabic opens the conversation; disabled while AI features are off.
- **Playwright:** `weekly-draft.spec.ts`, desktop and mobile.
  - It turns drafts on, sets Friday 16:30, prepares a draft, and checks it opens in Copilot with the notice and a pending proposal.
  - It then deletes the conversation and restores the settings.
- **Results:**
  - **Backend:** 272/272 on SQLite and PostgreSQL 16; Pint passes.
  - **Frontend:** Vitest 118/118.
  - **Playwright:** 34/34.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning) and build.
- **Manual check** with demo data (EN desktop, AR Pixel 7 dark): no overflow and no unexpected console errors. The scheduled command on the demo account produced one draft and one Arabic notification; a second run produced nothing.
  - Fixed during QA: on mobile the "Plan from" selector was cut off at half width; it now takes a full row.
  - The demo drafts, the notification and the settings were removed afterwards.
- **Not verified:** Web Push delivery of the draft notification to a real device. It uses the existing V3 push pipeline, which is opt-in per device and off by default for the planning category.

## Known limitations (V16)
- **Drafts always plan the coming week.** A draft prepared on a Monday plans the following week, not the current one.
- **One schedule per user.** There are no separate drafts for work and study, and no choice of how many weeks ahead.
- **The scheduler needs `schedule:run` (cron) on the server.** It checks every 15 minutes, so a draft can arrive up to 15 minutes after the chosen time. Missed days are not caught up.
- **The draft is computed when it is prepared.** Calendar changes made afterwards are caught at apply time (clashing blocks are refused), not by re-planning.
- **The first answer always comes from the local planners**, as for suggestions opened in Copilot (V14).

# V17 — Voice in Copilot

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (ef77767) after PR #15 (V16) was merged. Merged into `main` as PR #16.

## What changed
- **Dictation in the Copilot composer.** A microphone button next to Send uses the browser's built-in speech recognition (Web Speech API, `src/lib/voice.ts`). No new dependency, and no LifeOS endpoint receives audio.
- **Never sent by voice.**
  - Spoken text is appended to the message box for the user to read, edit and send.
  - While listening, the live transcript shows under the box ("Listening… “plan my week around”").
  - Listening stops after a pause, with the button (pressed state, Esc), or when a message is being sent.
- **Language.** English or Arabic follows the app language, using the browser's regional variant when it has one (en-GB, ar-EG…); otherwise en-US or ar-SA.
- **Consent per device.** The first use on a device explains that some browsers (Chrome, Edge) send the audio to their own speech service, and that LifeOS never receives or stores audio. It starts only after "Allow and start". The choice is kept in this browser (`localStorage`); declining records nothing.
- **Account switch.**
  - "Voice input in Copilot" in the AI Control Center (`voice_input`, on by default; each device still asks first).
  - Switching it off hides the button and forgets this device's consent. "Forget voice consent on this device" is also available.
  - Exposed as `voice_allowed` in `/api/assistant/status` and `external_ai.voice` in the AI settings.
- **Browser support.** The button only appears where the browser has speech recognition (Chrome, Edge, Safari; not Firefox).
- **Errors** are explained in both languages: microphone blocked or missing, nothing heard, speech service unreachable, language not supported.

## Testing
- **Backend:** `VoiceInputTest` (2 tests): allowed by default, switch off and back via `/api/settings`, validated, per account. The `AiControlCenterTest` expectation now includes `voice`.
- **Vitest:** `v17.test.tsx` (5 tests), with a fake recognizer driven by the test.
  - Hidden without browser support.
  - The consent dialog before the first start; interim text shown; final text appended without sending; Esc stops; no second consent.
  - Declining starts nothing; Arabic recognition language and the "blocked" message.
  - Listening stops while a message is sent.
  - Regional language choice.
- **Playwright:** `voice.spec.ts`, desktop and mobile. It replaces both `SpeechRecognition` and `webkitSpeechRecognition` (Chromium has both).
  - Consent, then the composer is filled, nothing is sent, and a second dictation appends without asking.
  - The account switch in Arabic hides and restores the button.
- **Results:**
  - **Backend:** 274/274 on SQLite and PostgreSQL 16; Pint passes.
  - **Frontend:** Vitest 123/123.
  - **Playwright:** 38/38.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning) and build.
- **Manual check** (EN desktop, AR Pixel 7 dark, fake recognizer): no overflow and no unexpected console errors.
  - Fixed during QA: the composer's send-button rule (`.chat-form .primary`, no padding) also hit the consent dialog's button inside the form and clipped its label. It is now scoped to `.chat-form > .primary`.
  - Fixed during QA: the idle microphone was barely visible; it now uses the quiet button style.
- **Not verified:** real speech recognition with a microphone, in any browser. Recognition quality, Arabic dialects and how each browser's speech service handles audio are outside LifeOS and were not tested.

## Known limitations (V17)
- **Dictation only:** there is no spoken reply (text-to-speech) and no voice commands. "Apply" still requires the button.
- **Depends on the browser.** Firefox has no Web Speech recognition, so no button. Chrome and Edge need a network connection to their speech service.
- **Language follows the app language;** a mixed English/Arabic sentence is transcribed in one language.
- **Consent is per browser.** Clearing site data asks again.

# V18 — Goal progress reviews

Branch `claude/magical-johnson-1s7q7b`, restarted from `main` (db2cf35) after PR #16 (V17) was merged. **Not committed, not pushed** — waiting for approval.

## What changed
- **Reviewing a goal** (`GoalReviewService`) states what happened in a month:
  - progress, and its change since the previous review;
  - linked tasks completed in the month;
  - focus minutes on those tasks;
  - milestones;
  - open and overdue tasks;
  - the existing goal status with its reasons;
  - the pace needed per month to finish by the deadline.
- **Proposed next step** (a pending proposal, nothing applied):
  - time this week for the goal's three most important open tasks (find-time, V11);
  - or, without open tasks, dated tasks from its milestones (goal plan, V5);
  - a completed goal gets no proposal.
- **Where reviews come from:**
  - **"Review this month"** on each goal card on the Goals page (`POST /api/goals/{id}/review {language}`, `throttle:assistant`). It opens a new Copilot conversation with the review of the month so far.
  - **In chat:** "How is my progress on my marathon goal?", "Review my goal …", "راجع هدفي …" route to the new local `goal_review` intent. The review is computed from the user's own data, so it is answered locally even when an external provider is on.
  - **Monthly review** (opt-in feature `goal_reviews` in the AI Control Center, off by default). `lifeos:goal-reviews` runs hourly. On the 1st of the month from 09:00 local, once per month, it prepares one Copilot conversation for the month that ended:
    - one line per goal that is not completed (at most 8, those needing attention first): percent, change, status, tasks, focus minutes;
    - a button per goal ("Review “…”") that opens that goal's full review for the month, with its proposed next step. The overview itself proposes nothing.
    - It sends one "review" notification.
- **Snapshots** (new table `goal_reviews`, additive migration): one row per goal and month with percent, tasks done, focus minutes and status. They let the next review show the change, and are refreshed when a month is reviewed again. They are deleted with the goal and with "Delete AI data".
- **Audit:** `goal_reviewed`, shown in the AI activity log.
- **Arabic:** goal titles inside Arabic review texts and buttons are wrapped in Unicode direction isolates, so an English title keeps its word order.

## Testing
- **Backend:** `GoalReviewTest` (4 tests).
  - A review of the month so far, with a `find_time` proposal for the open task:
    - only this month's task and focus minutes count;
    - milestones, open tasks and pace (12%/month) are stated;
    - a snapshot is stored, nothing is written, and the action is audited.
  - A month later the Arabic review shows "+15٪", with the title isolated.
  - Without open tasks: a goal plan from the milestones. A completed goal: no proposal.
  - Chat routing and privacy: another user's goal returns 404, an invalid language 422, and "Delete AI data" removes the snapshots.
  - The monthly review:
    - off by default; not before 09:00; prepared once;
    - an overview without the completed goal and without proposals; snapshots; the notification;
    - picking a goal opens its October review with a goal plan; a goal that wasn't offered returns 422; the next month is prepared again.
  - `AiControlCenterTest` expects `goal_reviews` in "Delete AI data", and the existing fixtures include the new feature.
- **Vitest:** `v18.test.tsx` (2 tests): "Review this month" posts and opens the conversation; the Arabic label.
- **Playwright:** `goal-review.spec.ts`, desktop and mobile. It creates a goal with a milestone, reviews it from the Goals page, and checks the review text and a pending proposal with the milestone task; then it deletes the conversation and the goal.
- **Results:**
  - **Backend:** 278/278 on SQLite and PostgreSQL 16; Pint passes.
  - **Frontend:** Vitest 125/125.
  - **Playwright:** 40/40.
  - Also clean: `tsc -b`, ESLint (0 errors, 1 pre-existing warning) and build.
- **Manual check** with demo data (EN desktop, AR Pixel 7 dark): goal card, single-goal review with three time blocks, and the monthly overview with 8 goal buttons. No overflow and no unexpected console errors.
  - Fixed during QA: English titles in Arabic text were reordered ("«workouts this year 150»").
  - The demo conversations, snapshots, notification and setting were removed afterwards.

## Known limitations (V18)
- **Progress history starts with the first review.** Goals keep only their current progress, so the first review cannot show a change, and changes between reviews are not dated more finely.
- **"Tasks done" relies on `completed_at`.** Tasks completed before that field was set are not counted.
- **The monthly time is fixed:** the 1st at 09:00 local, with the hourly scheduler (cron) required. A missed day is not caught up.
- **At most 8 goals in the monthly overview.** Completed goals are left out.
- **Next steps cover this week only** (find-time) or the goal's milestones (goal plan). There is no multi-week schedule for the month ahead.
