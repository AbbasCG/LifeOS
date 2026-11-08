# LifeOS — CI/CD and production deploy

CI (`.github/workflows/ci.yml`) tests; CD (`.github/workflows/deploy.yml`) releases. They are separate workflows: CD never runs
tests itself, it refuses any commit that has no green push-CI run on `main`.

```
you review + merge a PR ─► CI on the merge commit (Laravel sqlite+pgsql, React, Playwright, Deploy tooling)
                   │ success
                   ▼
   Deploy production workflow (workflow_run) ── resolve (scripts/deploy-resolve.sh), for that exact full SHA:
        CI run = push to main, success │ SHA on main + green push-CI for it │ still the head of main │ came from a merged PR │ not deployed before
                   │ any check fails ─► skipped / refused, nothing is shipped
                   ▼
        `production` environment (secrets only here; deployment branch = main)
                   │
        ssh (pinned host key, restricted key) ─► forced command ─► scripts/deploy-production.sh deploy --sha <commit>
                   │            pre-flight ─ lock ─ (verified pg_dump only if migrations are pending) ─ composer ─ build ─ swap ─ health
```

## Hybrid policy (who approves what)

- **Claude Code / developers** work on `claude/*` branches, run the tests and open pull requests. Nothing else is automated before the merge.
- **You** review and merge. Branch protection (PR + the five CI checks) is what stops a red or unreviewed change from reaching `main`; the deploy
  workflow never bypasses it.
- **Merge commit → CI → deploy is automatic** (no second approval) when the repository variable `AUTO_DEPLOY` is `true`. Delete it or set it to anything
  else to stop automatic deploys immediately; manual **Run workflow** (deploy, `dry_run`, `rollback`) always works.
- A **failed, cancelled or skipped CI never deploys** (the workflow condition and the resolver both check the conclusion). The deploy for that run is
  gone for good; fix forward with a new PR, or deploy a green SHA by hand.

**Protection of `main` in force** (repository ruleset "LifeOS — Main Protection", enforcement `active`, no bypass actors; read from the GitHub API on
2026-11-08, re-check it with `gh api repos/AbbasCG/LifeOS/rules/branches/main`): no branch deletion, no force-push, a pull request is required (0 approvals,
all review threads resolved), and the branch must be up to date with `main` and pass `Laravel (pgsql)`, `Laravel (sqlite)`, `React`, `Browser (Playwright)`
and `Deploy tooling`. The settings of the `production` environment (required reviewers, deployment-branch rule) cannot be read with the repository API
token used for these checks — confirm them on the Environments settings page.

A merge that only changes documentation is deployed too: the server fast-forwards, `composer install` is a no-op, the frontend is not rebuilt (its source tree
is unchanged), and PHP-FPM is reloaded and the queue worker restarted (step 7 above).

Automatic decision table (implemented in `scripts/deploy-resolve.sh`, 81 offline checks):

| Situation | Result |
|---|---|
| CI `success`, push to `main`, SHA still head of `main`, from a merged PR, never deployed | deploy **that full SHA** |
| CI failed / cancelled / skipped / not a push to `main` / fork | skipped, nothing asked of GitHub |
| An older CI finishes after a newer commit landed (SHA is no longer head) | skipped; the newer commit deploys through its own CI run |
| Commit pushed straight to `main` (no merged PR) | skipped (deploy it manually if intended) |
| Same SHA already deployed successfully (re-run CI, re-delivered event, queued twin) | skipped; dry runs and rollbacks do not count |
| No successful CI for the SHA, not on `main`, malformed SHA, GitHub API error | refused / job fails; nothing is shipped |
| Two merges in quick succession | runs are queued (`concurrency: deploy-production`, never cancelled mid-release); the one that runs re-checks "is this still head?" at its own start |

The SHA that is deployed is always the one CI tested (`workflow_run.head_sha`), never "latest main" at deploy time. The server independently refuses a
target that is not on `origin/main` or not a fast-forward of what it runs.


## What the server script does (`scripts/deploy-production.sh`)

Runs on the VPS as the unprivileged user `lifeos` (it refuses root). Modes: `check`, `deploy --sha`, `rollback --sha`, both with `--dry-run`.

1. **Pre-flight (read-only):** user, paths, writable `storage/` + `bootstrap/cache/` + `frontend/`, `.env` present, **Node.js** (see below), tools (git, php,
   composer, npm, curl, flock, pg_dump ≥ 16), PostgreSQL reachable from the host, and the two sudo rules.
   **Node.js:** a non-interactive SSH session does not load NVM, so plain `node` is the system one (Ubuntu 24.04: v18, too old for Vite). The script
   therefore sources `~/.nvm/nvm.sh` and runs `nvm use $NODE_MAJOR` (default **24**) itself, then requires `node -v` to be exactly that major, and logs
   the Node and npm in use. NVM missing, version not installed or any other major: it stops here, before anything is changed — `check` shows the same,
   so the server can be verified without deploying. Setup for the deploy user: `nvm install 24 && nvm alias default 24`.
2. **Lock:** `flock` on `/var/lib/lifeos-deploy/deploy.lock` — a second deploy is refused, not queued.
3. **Git:** must be on `main` with a clean tree (`git status --porcelain`: any tracked change or non-ignored stray file aborts; `.env*`, fonts and `dist`
   are git-ignored so they never count). `git fetch origin main`; the target must be a full 40-hex commit that is an ancestor of `origin/main` and a
   fast-forward of what is deployed (rollback: an ancestor of it).
4. **Plan:** `--dry-run` stops here and reports the plan, including how many package operations `composer install` would apply to the current `vendor/`.
   `composer install` *always* runs (no-op when `vendor/` matches `composer.lock`, repair when it lags). The frontend is rebuilt whenever `dist/` was not
   built from the target's exact `frontend/` tree (marker `dist/.lifeos-frontend-tree`), so a deploy whose target equals HEAD still repairs a stale or
   hand-built `dist/`. Migrations run only if `migrate:status --pending` lists some.
5. **Release:** `git merge --ff-only` (no-op when already there) → `composer install --no-dev --optimize-autoloader` (from `composer.lock`, never `update`) →
   when a build is needed: `npm ci` + build into `frontend/dist.new` (`LIFEOS_BUILD_ID=<sha>`) while the live `dist` keeps serving.
6. **Migrations — only when `php artisan migrate:status --pending` lists some:** `pg_dump -Fc` over TCP (credentials from `.env` through a temporary 0600
   `.pgpass`, never on a command line) → verified (exit code, non-empty, `pg_restore --list` shows table data, SHA-256 written) → only then
   `php artisan migrate --force`. Keeps the 14 newest dumps in `/var/lib/lifeos-deploy/backups` (mode 700/600).
7. **Cut-over:** `dist` → `dist.prev`, `dist.new` → `dist`; `artisan optimize:clear && optimize`; `sudo systemctl reload php8.3-fpm`; `sudo systemctl restart lifeos-queue`.
   Before the swap the new `dist.new` is made readable by the web server (`chmod -R u=rwX,go=rX`: directories 755, files 644, owner unchanged, never
   world-writable) and verified with `find`; a deploy that keeps the existing `dist` repairs it the same way. See "Permissions and Nginx" below.
8. **Health:** `/api/user` signed-out = **401 + `application/json`** (a 500 here is the bug fixed in PR #48), `/` = 200 (403 = Nginx cannot read `frontend/dist`),
   `/up` = 200; retries ×10. A `/up` that Nginx answers with 404 is logged as a note (Laravel is proven through `/api/user`), not a failure, unless
   `HEALTH_REQUIRE_UP=1`.
9. **Log:** `/var/lib/lifeos-deploy/deploy.log` (everything) and `history.log` (one line per deploy: who, from, to, result, backup file).

After a revert the script also proves the restored checkout is consistent: `composer install --dry-run` must report **0** operations (vendor/ matches
`composer.lock` of the restored commit; if not, it reinstalls from the lock and checks again), the live `frontend/dist` is confirmed to be the one that was
serving before (it is only replaced after a successful build), and, when `composer install` had real work to do before the failure, PHP-FPM is reloaded and the
queue worker restarted so no process keeps classes from a vendor/ that changed under it.

Automatic reversal exists only while nothing irreversible has happened: a failure *before* migrations/cut-over (composer, build, backup, migration status)
moves the code back with `git reset --keep <previous>` (refuses to overwrite local changes; never `--hard`) and leaves the live site untouched. After
migrations the script does **not** guess — it exits non-zero, prints the backup path and stops (see Rollback). Exit code 3 = released but unhealthy.

It never restarts Docker, PostgreSQL or n8n, never runs `git reset --hard`, `git clean` or `git add`, and never prints `.env` values.

## The script that runs is the one already on the server

The forced command executes `/var/www/lifeos/scripts/deploy-production.sh` from the **currently checked-out** commit, i.e. before the deploy moves it. A fix
to the script (such as the Node check) therefore only protects the deploys that start *after* the server's checkout contains it. To bring a server that still
has an older script up to date without a half-finished release: as the deploy user, `git -C /var/www/lifeos fetch origin main` and
`git -C /var/www/lifeos merge --ff-only <commit>` (code only; nothing is built or restarted), then run **Deploy production** with that same commit
as the target: the new script runs, installs from `composer.lock` and rebuilds a `dist/` that was not built from this `frontend/` tree.

## Rollback

*Code only* (safe, idempotent): Actions → **Deploy production** → action `rollback`, sha = a previous commit (see `history.log` / `git log`).
This moves the checkout back, rebuilds the frontend and reloads PHP-FPM/queue. **It never touches the database.**

*Database:* Laravel migrations in this project are additive, so the previous code normally runs on the new schema. If a migration itself was wrong:
1. Prefer a **fix-forward** migration (new commit, normal deploy).
2. Restoring the pre-deploy dump loses everything written since it was taken. Only do it deliberately, by an administrator, e.g. into a *new* database first:
   `createdb lifeos_restore && pg_restore --no-owner -d lifeos_restore /var/lib/lifeos-deploy/backups/<file>.dump`, inspect, then decide on swapping.
   Verify the file before use: `sha256sum -c <file>.dump.sha256`. The script deliberately has no automatic restore.

## One-time server setup (an administrator, as root; nothing here is automated)

```bash
# 1. Deploy user (owns the checkout; NOT in the docker group; no password login)
id lifeos || adduser --disabled-password --gecos "" lifeos
install -d -o lifeos -g lifeos -m 750 /var/lib/lifeos-deploy
chown -R lifeos:lifeos /var/www/lifeos          # git checkout, storage/, bootstrap/cache/, frontend/ writable by lifeos
# php-fpm must be able to write storage/ and bootstrap/cache/: run the pool as lifeos, or give www-data group write on those two directories.

# 2. Exactly two privileged commands, nothing else (validate before installing)
cat > /etc/sudoers.d/lifeos-deploy <<'SUDO'
lifeos ALL=(root) NOPASSWD: /usr/bin/systemctl reload php8.3-fpm, /usr/bin/systemctl restart lifeos-queue
SUDO
chmod 440 /etc/sudoers.d/lifeos-deploy && visudo -cf /etc/sudoers.d/lifeos-deploy

# 3. PostgreSQL client matching the server, and the container must publish the port on loopback only
apt-get install -y postgresql-client-16      # pg_dump >= 16
#    in /opt/lifeos/database/compose.yaml:  ports: ["127.0.0.1:5432:5432"]   (apply with your normal procedure; this script never restarts it)
#    backend/.env must use DB_HOST=127.0.0.1, DB_PORT=5432 and the lifeos role (it already does if the app connects that way).
#    Check:  pg_isready -h 127.0.0.1 -p 5432

# 4. Forced-command entry point (root-owned, so a compromised checkout cannot widen the key's rights)
install -o root -g root -m 755 /var/www/lifeos/scripts/deploy-ssh-entrypoint.sh /usr/local/bin/lifeos-deploy-entry

# 5. A dedicated key, generated on your machine (never reuse a personal key); put the PUBLIC half in lifeos's authorized_keys
#    ssh-keygen -t ed25519 -N "" -C lifeos-github-deploy -f ./lifeos_deploy
install -d -m 700 -o lifeos -g lifeos /home/lifeos/.ssh
echo 'restrict,command="/usr/local/bin/lifeos-deploy-entry" ssh-ed25519 AAAA…public-key… lifeos-github-deploy' >> /home/lifeos/.ssh/authorized_keys
chown lifeos:lifeos /home/lifeos/.ssh/authorized_keys && chmod 600 /home/lifeos/.ssh/authorized_keys
#    `restrict` disables shell, PTY and all forwarding; the entry point accepts only: check | deploy <sha> [dry-run] | rollback <sha> [dry-run].
#    Optional: prefix with from="<GitHub Actions egress ranges>" — those change often, so it is NOT recommended as the only control.

# 6. Make sure sshd allows the key (PasswordAuthentication no is recommended; PermitRootLogin no)
```

Verify without changing anything (from your machine, using the new key): `ssh -i lifeos_deploy lifeos@<host> check` → "Check ok".
Note the very first run uses the checkout's current copy of `deploy-production.sh`; later runs use the copy from the commit that was deployed *before*
(the script runs before it fast-forwards). Review changes to `scripts/` like production code.

## GitHub setup (Settings of `AbbasCG/LifeOS`)

1. **Environments → New environment → `production`.** Add **Required reviewers** (yourself or a second person) and, if available, "Prevent self-review"
   and a deployment-branch rule: *Selected branches → `main`*. Required reviewers are available for public repositories and for private ones only on
   paid plans — **NOT VERIFIED for this repository; check the screen.** If the option is missing, see "Without environment protection" below.
2. In that environment add **secrets** `DEPLOY_SSH_KEY` (private key, whole PEM/OpenSSH text) and `DEPLOY_KNOWN_HOSTS`, and **variables** `DEPLOY_HOST`,
   `DEPLOY_USER` (= `lifeos`, never `root`) and optionally `DEPLOY_PORT`.
   `DEPLOY_KNOWN_HOSTS` must come from the server itself, not from a scan by the runner. On the server:
   `echo "life.softbuild.nl,<server-ip> $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"` — paste that single line as the secret, and compare
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` with the fingerprint your first manual login showed. The file is pinned
   (`StrictHostKeyChecking=yes`), so the job fails closed if the host key ever changes.
3. **Branch protection on `main`:** require pull requests and the CI checks (`Laravel (sqlite)`, `Laravel (pgsql)`, `React`, `Browser (Playwright)`, `Deploy tooling`).
   `Browser (Playwright)` is a **gate job**: the browser tests run as six `Playwright shard n/6` jobs plus `Playwright dev server (pickers)`, and the gate
   (kept under the old name) fails unless all of them succeeded, even when some were cancelled or skipped. Require only the five names above; do not
   require the shard names (they would change whenever the shard count does). The deploy workflow needs no change: it looks for a successful `CI` run
   for the commit, and a run is only successful when every job, shards and gate included, is.
4. Leave the repository variable `AUTO_DEPLOY` **unset** at first. First deploy manually (below). Set `AUTO_DEPLOY=true` (Settings → Secrets and
   variables → Actions → Variables) only when you want the hybrid policy above: from then on every merged PR whose CI is green on the merge commit is
   deployed without further clicks. If the `production` environment still has **Required reviewers**, each automatic run waits for that approval instead
   (safer, but not hands-free); remove the reviewers only if you accept fully automatic production releases. Keep the deployment-branch rule
   (*Selected branches → `main`*). **NOT VERIFIED: the real environment and branch-protection settings.**
5. Actions → General → "Workflow permissions": read-only is enough (the workflows request only `contents: read` and `actions: read`).

### Without environment protection

Do not enable `AUTO_DEPLOY`. Deploy only through **Run workflow** (`workflow_dispatch`), which already requires write access to the repository; the click
is then the approval. Add a second factor yourself: keep `main` protected (PR + CI required), restrict who has write access, and run the same
commands from your own machine instead (`ssh lifeos@host "deploy <sha>"` with the same restricted key) when you want a human-in-the-loop that GitHub cannot enforce.

## First activation (safe order)

1. Merge the PR containing these files (CI must be green, including `Deploy tooling`).
2. Do the server setup and GitHub setup above.
3. `ssh -i lifeos_deploy lifeos@host check` → pre-flight passes (this does not change anything).
4. Actions → **Deploy production** → Run workflow, `dry_run` ✔ → approve → read the plan in the log.
5. Same again with `dry_run` off, on a quiet moment; watch the health check lines. Keep a terminal on the server: `tail -f /var/lib/lifeos-deploy/deploy.log`.
6. Practise `rollback` once with a dry run.
7. Only then set `AUTO_DEPLOY=true`. Watch the first automatic run end to end (Actions → Deploy production, run title `Deploy <sha>`), and keep `rollback` ready.

## What the very first real deploy does (server already on the target commit)

Example: server HEAD `283be8b`, `--sha 283be8b…`, `vendor/` behind `composer.lock` (18 Symfony updates), `dist/` hand-built.
1. Pre-flight, lock, clean-tree check; `fetch`; target is on `origin/main`; "Already at …" (no merge needed).
2. `composer install --no-dev --optimize-autoloader` applies the 18 pending updates from the lock (no `update`, `composer.json`/`lock` untouched).
3. `npm ci` + `vite build` into `frontend/dist.new` (the live site keeps serving); marker written.
4. `migrate:status --pending`: none expected → no backup, no migrate. If some are pending: verified `pg_dump` first, then `migrate --force`.
5. `dist` → `dist.prev`, `dist.new` → `dist`; `optimize`; `reload php8.3-fpm`; `restart lifeos-queue`.
6. Health: `/up` 200, signed-out `/api/user` 401 JSON, `/` 200. Failure before step 4's migrate reverts automatically; exit 3 = released but unhealthy → `rollback`.
Nothing touches `.env`, Docker, PostgreSQL, n8n or Nginx.

## Permissions and Nginx

**Why the site returned 403.** The script runs as `lifeos` with `umask 027`, so Vite wrote `dist/` as 750/640 (and Node's `copyFile` keeps the 600 mode of a
private font). Nginx runs as `www-data`, which is not in the `lifeos` group, so it could not enter `dist/`.

**What the script does now** (`DIST_PUBLIC=1`, default): after every build, and when it keeps an existing `dist`, it applies `chmod -R u=rwX,go=rX` to the
directory that is about to go live, so directories are 755 and files 644 (the minimum for another user to read). Ownership stays `lifeos:lifeos`; nothing is
777 or world-writable; only `frontend/dist.new` / `dist` are touched. Pre-flight (and `check`) also refuses if a directory above `frontend/dist` lacks the
"others execute" bit (`chmod o+x <dir>` on the parents, e.g. `/var/www/lifeos` and `frontend`), and warns when the live `dist` is currently unreadable
(the next deploy repairs it). `DIST_PUBLIC=0` switches this off if access is granted another way (e.g. ACLs for `www-data`).

Reference Nginx server block (**NOT VERIFIED against the real server** — adapt paths and the PHP-FPM socket):

```nginx
server {
    server_name lifeos.example;                      # TLS directives as already configured
    root /var/www/lifeos/frontend/dist;              # React build, read-only for www-data
    index index.html;

    location / { try_files $uri /index.html; }       # SPA fallback

    # Laravel: API, Sanctum and the framework health route all go to public/index.php
    location ~ ^/(api|sanctum)/ { include fastcgi_params; fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_param SCRIPT_FILENAME /var/www/lifeos/backend/public/index.php; fastcgi_param SCRIPT_NAME /index.php; }
    location = /up              { include fastcgi_params; fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_param SCRIPT_FILENAME /var/www/lifeos/backend/public/index.php; fastcgi_param SCRIPT_NAME /index.php; }
}
```

Do **not** add `location = /up { return 404; }` — Laravel serves `/up` (framework health route) and an explicit 404 hides it from monitoring. If you keep
it, the deploy still passes because `/api/user` proves PHP-FPM + Laravel + database middleware; set `HEALTH_REQUIRE_UP=1` once `/up` is routed to make a missing
route fail the deploy. After editing Nginx: `sudo nginx -t && sudo systemctl reload nginx` (an administrator step; the deploy script never touches Nginx).
Quick checks on the server: `namei -m /var/www/lifeos/frontend/dist/index.html` (every row needs `x` for others on directories, `r` on the file) and
`curl -sI http://127.0.0.1/` / `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/up`.

## Tests

`scripts/tests/deploy-production.test.sh` (also CI job **Deploy tooling**, together with `deploy-resolve.test.sh` and `workflow-lint.test.sh`) runs `bash -n`, `shellcheck`, `actionlint` and 110+ offline scenarios (`deploy-production.test.sh`) and, for the automatic decision, `scripts/tests/deploy-resolve.test.sh` (81 checks against a stubbed GitHub API: failed CI, stale CI, direct push, duplicates, dry runs, API errors, manual and rollback paths, workflow guard rails) against a
temporary git remote with stub binaries: bad/short/unknown commits, dirty tree, untracked files, wrong branch, root, missing sudo rule, concurrent
deploys, dry run, deploy without/with migrations (backup strictly before migrate), failing/empty/unverifiable backup, failing build, failing
migration, unhealthy API, `dist` permissions (nested dirs, private font, repair of an existing `dist`, untraversable parent), `/up` 404 vs 500 and an unreadable `dist` (403), fast-forward rules, rollback (never migrates), and the SSH forced command against injection attempts.
It cannot reach any server and is safe to run anywhere.

## What stops a bad commit reaching production (CI gate and health checks)

An automatic deploy happens only if **all** of these hold; a red CI run therefore never deploys, however many times it is re-run.

| Layer | Where | What it checks | Covered by |
|---|---|---|---|
| 1. Workflow condition | `deploy.yml` `resolve.if` | `AUTO_DEPLOY == 'true'`, the triggering CI run's own `conclusion == 'success'`, event `push`, branch `main`, this repository | `deploy-resolve.test.sh` "workflow guard rails" |
| 2. Resolver | `scripts/deploy-resolve.sh` (taken from `main`) | the same conclusion again; the SHA is on `main`, is still its head, belongs to a merged PR, has a successful push CI run **for exactly that SHA**, and was not deployed already | `deploy-resolve.test.sh` (83 scenarios, incl. "a failed CI run is skipped even though an earlier green run exists for the same SHA") |
| 3. CI itself | `ci.yml` | one run is green only if every job is: Laravel (SQLite, PostgreSQL), React, **Deploy tooling**, all Playwright shards and the "Browser (Playwright)" gate. No `continue-on-error` anywhere | `workflow-lint.test.sh` "not made optional" |
| 4. Server health | `deploy-production.sh` `health_check` | after cut-over: `/api/user` signed-out = 401 + JSON, `/` = 200, `/up` = 200 (or 404, see below); retries x10; otherwise **exit 3 "UNHEALTHY"** and the previous `dist` is kept for a code-only rollback. Nothing is rolled back automatically | `deploy-production.test.sh` (health scenarios) |

Evidence from production: when CI #153 went red three times (the `actionlint` download answered 504), the workflow runs #39, #40 and #41 were **skipped**, production stayed
on #38, and the same commit deployed as #42 only after CI turned green.

### Workflow lint without a single download host

The "Workflow lint" step used to run `pip install actionlint-py`, which builds from source and downloads the binary from GitHub Releases. Since the CI hardening change (phase 2) the job
(1) restores a cached `~/.local/bin/actionlint` (key `actionlint-1.7.12-<os>-<arch>`), otherwise (2) `scripts/ci-install-actionlint.sh` runs `go install ...@v1.7.12` (Go module
proxy and checksum database), otherwise (3) `pip install actionlint-py==1.7.12.25`, each with retries, and verifies the version. If no route works the job **fails**: the lint is
never skipped. Then the real lint runs on `.github/workflows/*.yml`, and `scripts/tests/workflow-lint.test.sh` proves the installer's fallbacks (with stubs) and that known-bad
workflow files (`scripts/tests/fixtures/workflows/`: unknown job key, `needs` on a missing job, undefined `github` property) are still rejected while a valid one is accepted.
To change the version: edit `ACTIONLINT_VERSION`/`ACTIONLINT_PIP_VERSION` defaults in the script and the cache key in `ci.yml` together.

### Risk of `HEALTH_REQUIRE_UP=0` (the default) — not changed here

`/up` is Laravel's liveness route. With the default `HEALTH_REQUIRE_UP=0` a `404` from `/up` is accepted with a log note, because a hardened Nginx may not route it
(this is what stopped deploy #21 on 2026-11-07 with the older, stricter script). What that default does and does not cover:

- Still enforced either way: `/api/user` = 401 JSON (PHP-FPM, Laravel, sessions and the database-backed guard answer) and `/` = 200 (the frontend files are readable).
- Not enforced: that Nginx routes `/up`. If a later Nginx change brings the 404 back, deploys keep passing and only the note in `deploy.log` shows it, so an external
  monitor that watches `/up` would go blind without the deploy ever failing.
- Every deploy from #29 (2026-11-08 00:27 UTC) to #42 logged `/up 200`, so the server does route it today.

Recommended, **as an administrator decision on the server** (this repository changes no production setting): after confirming
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/up` prints `200`, export `HEALTH_REQUIRE_UP=1` for the deploy user's environment (where the other
`deploy-production.sh` variables are set). To go back, remove it. A deploy that then fails on `/up` stops with exit 3 exactly like any unhealthy release.

### Optional hook: register release notes right after a healthy deploy

`DEPLOY_REGISTER_RELEASES=1` (default `0`, like `HEALTH_REQUIRE_UP`) makes the script run `php artisan lifeos:discovery:reconcile --no-interaction` after the health checks passed and
`current.sha` was written, in `deploy` and `rollback` alike (a rollback lets the app mark releases that left the code as absent). It never approves anything; a failure is logged as
`WARNING: lifeos:discovery:reconcile failed` and the deploy still ends `ok`; an unhealthy release (exit 3) and `--dry-run` never reach it. It changes no production setting by itself:
turning it on is an administrator's environment change. Details and the release-notes draft script: `docs/DISCOVERY.md`.

## Residual risks (read before enabling)

- Real server behaviour (PHP-FPM pool user, Nginx root, systemd unit names, published PostgreSQL port, sudo rules, `pg_dump` version) is **NOT VERIFIED** — the
  tests use stubs. The `check` and `--dry-run` modes exist to prove it step by step.
- A `pg_dump` is a logical snapshot; restoring it discards later data. Migrations are therefore fix-forward by policy.
- Between the frontend cut-over (two `mv`) and `reload`, requests may see a mixed old/new state for a moment (no maintenance mode by design).
- The deploy script that runs is the one already on the server; a malicious change to it would run on the next deploy — protect `main` and review `scripts/`.
- The `lifeos` user can write the application code, so an attacker who obtains the CI key can only run the three commands, but a compromised
  *repository* (merged malicious commit) is deployed with that user's rights. Required reviewers on `production` are the control for that.
