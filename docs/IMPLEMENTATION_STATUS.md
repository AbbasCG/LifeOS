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
