# Connected Accounts: setup, permissions, security and go-live

For the administrator who sets up providers and for whoever reviews the Hub. How the code is built is in `INTEGRATIONS.md`. **No real credentials belong in this file, in the repository or in CI.**

## 1. Set up a provider (administrator)

Open **Settings → Integrations → Provider configuration** (administrators only). For each provider create an OAuth client at the provider, paste the client id and secret, press **Test**, then switch it **on**. The secret is stored encrypted and is never shown again. The `.env` variables (`GOOGLE_CLIENT_ID`, …) still work as a fallback when nothing is saved on the screen.

The redirect URI must match exactly, including `https` and no trailing slash. Replace `https://life.softbuild.nl` with your own `FRONTEND_URL`.

| Provider | Redirect URI | Scopes requested for reading | Extra scope, only if the person allows changes |
|---|---|---|---|
| Google Calendar | `https://life.softbuild.nl/api/integrations/google/callback` | `openid email profile …/auth/calendar.readonly` | `…/auth/calendar.events` |
| Google Tasks | `…/api/integrations/google_tasks/callback` | `openid email profile …/auth/tasks.readonly` | none (read only) |
| Microsoft Outlook Calendar | `…/api/integrations/outlook/callback` | `openid email profile offline_access User.Read Calendars.Read` | `Calendars.ReadWrite` |
| Microsoft To Do | `…/api/integrations/microsoft_todo/callback` | `openid email profile offline_access User.Read Tasks.Read` | none (read only) |
| Todoist | `…/api/integrations/todoist/callback` | `data:read` | none (read only) |

Provider notes:

- **Google:** Google Cloud Console → APIs & Services → enable *Google Calendar API* (and *Tasks API*) → OAuth consent screen → Credentials → *OAuth client ID*, type *Web application*. While the app is in *Testing*, only listed test users can connect and refresh tokens expire after 7 days; publish the app (and complete verification for sensitive scopes) before real use.
- **Microsoft:** Entra ID → App registrations → New registration, supported accounts as you need (default tenant `common`), platform *Web* with the redirect URIs above, then *Certificates & secrets* → new client secret. Note the secret's expiry date and renew it before then.
- **Todoist:** Todoist App Management → create an app, set the OAuth redirect URL. Todoist tokens do not expire and have no refresh token.
- ICS feeds need no setup; they are fetched read-only with SSRF protection.

## 2. What a person can allow

Every new connection is **read-only**. Under **Manage permissions** the person chooses:

| Permission | Meaning | Needs the provider to support it |
|---|---|---|
| read | LifeOS may read events and tasks | always |
| sync | background synchronisation | always |
| import | copy an item into LifeOS on request | tasks |
| export | send a LifeOS item to the service on request | calendars with write support |
| create / update / delete | change things at the service | calendars with write support |

Presets: *Read only*, *Read and create*, *Read, create and update*, *Full* (includes delete and asks for a confirmation). The effective permission is the person's choice limited by what the provider connection really granted; a missing scope shows as "re-consent required". Changing permissions requires a recent password confirmation. Disconnecting revokes the token at the provider when it supports revocation and deletes the stored tokens.

## 3. Sync directions and conflicts

| Direction | Effect |
|---|---|
| inbound | the service is read into LifeOS (default) |
| outbound | LifeOS updates the copies it added earlier. It never creates or deletes on its own |
| two-way | both of the above |
| manual | nothing runs by itself; the person presses *Sync* |

The direction in effect is never wider than the permissions. Conflict policy: *ask* (default; the conflict waits for the person), *prefer the service*, *prefer LifeOS*, *keep both*. Overwriting the service needs an explicit confirmation. Pausing stops all background work for that connection. Outbound runs every 15 minutes (`lifeos:sync-outbound`), updates at most 25 items per run, uses the item's etag so a newer change at the service is never overwritten silently, and stops on rate limit or revoked access.

## 4. Security review (what is enforced and where it is tested)

| Area | Control | Test |
|---|---|---|
| OAuth state / CSRF / replay | random state, stored hashed, bound to user and provider, expires, single use | `OAuthStateStoreTest`, `OAuthConnectionTest` |
| PKCE | verifier stored encrypted, sent only at token exchange | `OAuthStateStoreTest` |
| Tokens at rest | encrypted model casts; refresh under a lock | `TokenRefreshLockTest` |
| Secrets in answers and logs | never returned; redaction of logs and errors | `SecretRedactionTest`, `IntegrationsSecurityTest` |
| IDOR | every `{id}` route is scoped to the signed-in person; others get 403/404 and nothing changes | `IntegrationsSecurityTest` |
| Administrator role | gives configuration screens only, never other people's accounts or tokens | `IntegrationsSecurityTest` |
| Permission escalation | a write needs `ConnectionPermissions::authorize()`; a static test fails if a new writer skips it | `ConnectionPermissionsTest`, `IntegrationsSecurityTest` |
| Sensitive changes | password confirmation (423) and rate limit on permissions, sync settings and conflict resolution | `IntegrationsSecurityTest` |
| Audit | connect, disconnect, permission, sync-setting, conflict and write events are logged without secrets | `OAuthConnectionTest`, `SyncEngineTest` |
| Webhooks | signed, timestamped, replay protected | `WebhookTest` |
| SSRF (ICS and outbound) | scheme/port/host rules, private ranges refused after DNS resolution, no redirects to private hosts | `OutboundHttpGuardTest` |
| Unauthenticated access | every protected route answers 401 JSON | `RouteSecurityTest` |

Known limits: the OAuth callback requires the person to be signed in (a guest is sent to sign in first); background workers need `APP_KEY` stable, because rotating it makes stored tokens unreadable and every account must then be reconnected.

## 5. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| "Not set up yet" on a provider | no saved client and no `.env` values, or the provider is switched off | Provider configuration → fill in, Test, switch on |
| `redirect_uri_mismatch` | the URI at the provider differs from the one shown on the screen | copy it exactly, check `FRONTEND_URL` and `https` |
| "Access blocked" (Google) | app in Testing and the person is not a test user | add them, or publish the app |
| Connected but "re-consent required" | the write scope was not granted | open Manage permissions and grant access again |
| "Needs attention" after some days | refresh token revoked or expired (Google Testing, password change) | reconnect |
| Sync stuck at "paused" | the person or a repeated failure paused it | resume under Sync settings |
| Conflicts keep appearing | policy is *ask* and nobody resolved them | resolve them, or choose a policy |
| Many 429 answers | provider rate limit | LifeOS backs off by itself; wait for `Retry-After` |
| A stored secret shows "unreadable" | `APP_KEY` changed | enter the secret again |

## 6. Production readiness checklist

- [ ] `APP_KEY` set and backed up; `FRONTEND_URL` is the public https URL.
- [ ] Queue worker and the scheduler (`schedule:run` every minute) run under a supervised account.
- [ ] Each provider: OAuth client created, redirect URI exact, consent screen published or test users added, secret expiry noted in a calendar.
- [ ] Test connection passes on the Provider configuration screen for every enabled provider.
- [ ] One administrator account has two-factor enabled.
- [ ] Connect a test account of your own, check *read-only* is the default, widen one permission, sync, disconnect, and confirm the access disappears at the provider's security page.
- [ ] Log files show no tokens or secrets (they must not).
- [ ] Rollback known: the migrations of this feature are additive; disabling a provider on the screen stops new connections without losing existing ones.
