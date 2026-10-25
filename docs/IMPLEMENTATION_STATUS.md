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
