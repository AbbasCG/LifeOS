# Product updates and feature discovery (What's New)

Product Experience 2.0, phase **P2 — Release core**. Owner: Smart Experience track (`claude/smart-*`). This file explains how an announcement
gets in front of people, safely, and how to write one. The screens (P3) and the tour engine (P5) come later; P2 is the server side and
**shows nothing to anyone**: no release exists yet, and none can become visible without the two gates below.

## Three gates: a healthy deploy, an administrator who read the exact text, and the switch

```
file merged ──► deploy passes its health checks ──► reconcile registers it (draft) ──► an administrator approves ──► people see it
                (scripts/deploy-production.sh writes                                        (or withdraws it at any time,
                 /var/lib/lifeos-deploy/current.sha)                                          no deploy needed)
```

* A merge, a commit or a green CI run proves nothing about the site. The only proof is `current.sha`, which the deploy script writes **after**
  the health checks. `lifeos:discovery:reconcile` (every five minutes) registers releases only when that marker equals the commit the code is
  running now. A deploy that moved the code but did not finish healthy leaves the marker behind, so nothing is registered.
* Registered releases start as **draft**. `GET /api/admin/discovery/releases` lists them with `content_hash`, a fingerprint of everything a person
  would read (the release, the features it names or introduced, their tours). `POST …/{key}/approve` with that `content_hash` (an administrator,
  `users.is_admin`, two-factor authentication on, password confirmed in the last 15 minutes) publishes exactly that text; if the code holds other text
  by then the answer is 409 `content_changed`. `…/withdraw` hides it at once, never asks for the password. Both are audited (`release_approved`,
  `release_withdrawn`: release key and revision only; a repeated click is not logged twice).
* **Edited text needs a new approval.** A release is visible only while the fingerprint of the text in the running code equals the approved one. If
  the text changes after the approval, even in a deploy that has not finished, it disappears at once; once a healthy deploy confirms the new text
  it is a draft again (`needs_review` in the reconcile output).
* `DISCOVERY_AUTO_ACTIVATE=false` is a real kill switch: while it is off nothing is shown, whatever the table holds.
* A roll-back removes the release file from the running code; the next reconcile marks the row `absent` and it disappears. Rolling forward
  brings it back, with its approval, and without a second notification.
* If a content file is broken the app keeps working and shows nothing (and the error is reported).

## Switching it on: `DISCOVERY_AUTO_ACTIVATE` stays **off** until the marker can be read

`/var/lib/lifeos-deploy` is created `lifeos:lifeos` mode 750 (docs/DEPLOYMENT.md), so whether the account that runs `php artisan schedule:run`
can read `current.sha` depends on the server. This was **not verified** (the production server is never touched from development). Until it is:

* `DISCOVERY_AUTO_ACTIVATE=false` (the default). Reconcile does nothing, nothing is ever registered, nothing can be shown.
* To check, run **as the scheduler's account** (read-only): `php artisan lifeos:discovery:check-marker`. It prints the account, the marker's owner
  and mode, the marker commit, the running commit and the verdict. Exit code 0 means the marker could be verified.
* If the verdict is `marker_missing` or `marker_unreadable`, either give that account read access to the file (for example group `lifeos`
  with `g+rx` on the directory and `g+r` on the file), or have the deploy script also write the confirmed commit somewhere the app can read
  (a dedicated change to `scripts/`, announced in `docs/coordination/HANDOFFS.md`). Then set `DISCOVERY_AUTO_ACTIVATE=true`.
* `DISCOVERY_DEPLOY_MARKER` and `DISCOVERY_REPOSITORY_PATH` point to the marker and the checkout when they are elsewhere.
* The running checkout must be readable by git for that account ("dubious ownership" makes the commit unknown, which keeps activation off).

## Content files (`backend/resources/discovery/`)

All text exists in `ar`, `nl` and `en`. Files are named after their key. `php artisan lifeos:discovery:validate` (and the tests) check them,
including that media files exist under `frontend/public/discovery/<folder>/` and are small (image ≤ 512 KB, video ≤ 3 MB).

| Folder | File | Fields |
|---|---|---|
| `releases/` | `<key>.json` | `key`, `date`, `revision`, `importance` (`normal`/`important`), `audiences` (`web`, `mobile`), `title`, `summary`, `items[]` |
| | item | `type` (`new`/`improved`/`fixed`/`important`), `feature`, `title`, `body`, `image`, `video`, `link` (an item that names a feature may omit its text) |
| `features/` | `<id>.json` | `id`, `category`, `name`, `description`, `route`, `since` (release key), `client_version`, `new_days`, `requires[]`, `tour`, `hints[]`, `image`, `video`, `audiences` |
| `tours/` | `<id>.json` | `id`, `version`, `title`, `steps[]` (`target`, `route`, `reveal`, `title`, `body`, `placement`, `optional`) |

Rules the registry enforces:

* Links and routes are paths inside LifeOS (`/tasks`), never an address. Media comes from `/discovery/…` only (the content security policy).
* A tour step has no field that can click, type or submit; unknown fields are rejected. A step `target` is a stable name (`quick-add`) for a
  `data-tour` attribute, not a CSS selector.
* `requires` lists what a person's account needs: `admin`, `ai_enabled`, `voice_allowed`, `push_configured`, `integration_ready:<provider>`,
  `config:<flag>` (flags listed in `config/discovery.php`). An unknown name is rejected, and at run time an unknown name is never satisfied. A
  feature that requires `admin` is not mentioned to anyone else.
* `client_version` is a whole number that the front end bumps in the pull request that ships a feature's screen. A tab opened before the update is
  told to reload instead of being promised a screen it does not have.
* Only features of an approved, live release can be tried, tracked or hinted. A release is "important" only when people should be told: one
  in-app notification per person per release (category `updates`, which people can switch off), never one per fix.

## API (signed-in people; all of it concerns their own data)

| Request | Answer |
|---|---|
| `GET /api/discovery/bootstrap?surface=web\|mobile&client=<n>` | the announcement to show now (or `null`), `update_required`, `counts.unseen_updates`, `preferences.hints_enabled` |
| `GET /api/discovery/releases?surface=&client=` | the update history |
| `PUT /api/discovery/states/{release\|feature\|tour\|hint}/{key}` `{action}` | `seen`, `snoozed` (24 h, twice, then history only), `dismissed`, `started`, `step` (`step_index`), `completed`, `skipped`, `helpful`, `unhelpful` |
| `POST /api/discovery/features/{id}/try` | `{available, reason, route, tour}`; the route comes from the content file; records the first try |
| `GET /api/admin/discovery/releases`, `POST …/{key}/approve`, `POST …/{key}/withdraw` | administrators only |

Only keys and timestamps are stored (`user_discovery_states`); there is no free text anywhere, and the rows are in the person's data export and are
deleted with the account.

## Not in P2

The What's New screen and `/updates` (P3), "Try now" buttons, New badges and hints (P4), the tour engine (P5), the Discovery Center (P6), the release
notes drafter and the deploy-script hook (P7), usage statistics (P8). Dutch can be stored in content now; choosing Dutch in the app needs the small
language change (its own pull request).

## Feature discovery (P4)

`GET /api/discovery/guide` feeds the "New" marks and the contextual hints. A hint is written in the feature file (`hints[{id,target,route,text}]`)
and is shown only when the screen carries a matching `data-hint="target"` attribute (today `quick-add` on the top bar and the mobile tab bar).
Rules the client keeps: one hint per browser session, never over a dialog, a focus session or while typing, never repeated once seen, and silent when the
person turned tips off in Settings.

## Tours (P5)

A tour is `resources/discovery/tours/<id>.json` (1 to 12 steps) attached to a feature through its `tour` field. A step names a `target` (the `data-tour` id of an
element), may name a `route` to open first and `reveal: sidebar` when the target lives in the menu, and may be `optional`. Tours point and explain only; the file
format has no field for an action. The card is positioned by `placement` (`auto`, `top`, `bottom`, `start`, `end`; `start`/`end` follow the reading direction).
Menu items already carry `nav-<screen>` ids and the quick-add button carries `quick-add`. To tour a screen of another area, ask its owner for stable `data-tour`
ids (Handoff H-008) instead of editing the screen.

## First release content: `2026-11-08-everyday-capture`

Shipped in `backend/resources/discovery/`: one release, two features (`quick-capture`, `dutch-language`) and one tour (`quick-capture-tour`), every text in Arabic, Dutch and English.
What a person reads, in order: **New** Quick Capture in Arabic, Dutch and English (with "Try now", which opens `/tasks` and starts the one-step tour on the Quick add button),
**New** Nederlands is available (`/settings`), **New** updates, "New" marks and tips (link to `/updates`), **Improved** easier to use on a phone, **Fixed** waiting
changes are kept if sign-out fails. `php artisan lifeos:discovery:validate` checks it, and `ShippedContentTest` proves, for every release in the folder, that it appears in
the history in all three languages, is announced once, that "Try now" works for an ordinary account, that every route, link and tour target exists in the app, and that each
tour opens.

Having the files in the code shows nothing to anyone. To make it visible (every step is the owner's, nothing here is automatic):

1. Run `php artisan lifeos:discovery:check-marker` on the server as the account that runs the scheduler (Handoff H-009). It must say the marker is readable.
2. Set `DISCOVERY_AUTO_ACTIVATE=true` in the server's `.env` (default `false`: this is the kill switch) and reload PHP-FPM / config cache as for any `.env` change.
3. Wait for the next reconcile (every 5 minutes) after a healthy deploy: the release is then registered as a **draft**.
4. As an administrator with two-factor and a fresh password confirmation, read `GET /api/admin/discovery/releases`, check that `content_hash` is
   `c851cb5cbd8ad46c17daa3b8aa05faa93f5df9098d66ad1087a0428e15f2671b` (the fingerprint of the files in this commit; if it differs, the text on the server is not the text reviewed here),
   then `POST /api/admin/discovery/releases/2026-11-08-everyday-capture/approve` with that `content_hash`. There is no admin screen yet (optional phase P9).
5. People now see it: the announcement once per session, the history at `/updates`, "New" marks and the notification. `…/withdraw` hides it at once.

Any later edit of these files changes the fingerprint and needs a new approval.
