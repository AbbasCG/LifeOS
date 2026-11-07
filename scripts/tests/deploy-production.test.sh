#!/usr/bin/env bash
# Safe, offline tests for scripts/deploy-production.sh and scripts/deploy-ssh-entrypoint.sh.
# Everything happens in a temporary directory with a throw-away git "origin" and stub binaries (php, composer, npm, pg_dump, curl, sudo…):
# no network, no production server, no real database, no real Docker. Run:  scripts/tests/deploy-production.test.sh   (as root or any user;
# the script under test is executed as the unprivileged user "nobody" because it refuses to run as root).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/deploy-production.sh"
ENTRY="$(cd "$HERE/.." && pwd)/deploy-ssh-entrypoint.sh"
PASS=0; FAIL=0; T=""
# The fixture is created by root and then owned by "nobody"; tell git (command-line scope) that is fine for this test run only.
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" GIT_CONFIG_KEY_1=push.negotiate GIT_CONFIG_VALUE_1=false

as_deployer() { # run a command as the unprivileged user
  if [[ "$(id -u)" -eq 0 ]]; then setpriv --reuid=nobody --regid=nogroup --clear-groups "$@"; else "$@"; fi
}
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
has()  { grep -q -- "$1" "$2"; }
hasnt(){ ! grep -q -- "$1" "$2" 2>/dev/null; }

setup() {
  T=$(mktemp -d); chmod 755 "$T"
  mkdir -p "$T/bin" "$T/flags" "$T/state" "$T/home"
  # --- stubs ---------------------------------------------------------------------------------------------------------------------
  cat > "$T/bin/php" <<STUB
#!/usr/bin/env bash
echo "php \$*" >> "$T/calls.log"
case "\$*" in
  *"migrate:status"*) if [[ -f "$T/flags/pending" ]]; then echo "  2026_01_01_000000_new_table ........ Pending"; else echo " INFO  No pending migrations."; fi ;;
  *"artisan migrate --force"*) echo "MIGRATE" >> "$T/order.log"; [[ -f "$T/flags/migrate_fails" ]] && exit 1 ;;
esac
exit 0
STUB
  # composer: `install` makes vendor/ match composer.lock (a hash is kept in vendor/.lockhash); `install --dry-run` prints 18 package
  # operations while it does not (like the server's 18 pending Symfony updates) and none once it does.
  cat > "$T/bin/composer" <<STUB
#!/usr/bin/env bash
echo "composer \$*" >> "$T/calls.log"
mkdir -p vendor
lock=\$(sha256sum composer.lock 2>/dev/null | cut -d' ' -f1)
if [[ "\$*" == *--dry-run* ]]; then
  [[ "\$(cat vendor/.lockhash 2>/dev/null)" == "\$lock" ]] || for i in \$(seq 1 18); do echo "  - Upgrading symfony/pkg\$i (v7.4.21 => v7.4.23)"; done
  exit 0
fi
printf '%s' "\$lock" > vendor/.lockhash
exit 0
STUB
  cat > "$T/bin/node" <<STUB
#!/usr/bin/env bash
cat "$T/flags/system_node" 2>/dev/null || echo v24.0.0
STUB
  cat > "$T/bin/npm" <<STUB
#!/usr/bin/env bash
echo "npm \$* node=\$(node -v)" >> "$T/calls.log"
if [[ "\$1" == "ci" ]]; then mkdir -p node_modules; fi
if [[ "\$1" == "run" && "\$2" == "build" ]]; then
  v=\$(node -v); v=\${v#v}; [[ \${v%%.*} -ge 20 ]] || { echo "vite: Node.js 20.19+ or 22.12+ is required (found \$(node -v))" >&2; exit 1; }
  [[ -f "$T/flags/build_fails" ]] && exit 1
  out=dist; for ((i=1;i<=\$#;i++)); do [[ "\${!i}" == "--outDir" ]] && { j=\$((i+1)); out="\${!j}"; }; done
  mkdir -p "\$out"; echo "<html>\$LIFEOS_BUILD_ID</html>" > "\$out/index.html"
fi
exit 0
STUB
  cat > "$T/bin/pg_dump" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "--version" ]]; then echo "pg_dump (PostgreSQL) 16.4"; exit 0; fi
echo "BACKUP" >> "$T/order.log"
[[ -f "$T/flags/dump_fails" ]] && { echo "pg_dump: error: connection failed" >&2; exit 1; }
[[ -z "\${PGPASSFILE:-}" || ! -f "\$PGPASSFILE" ]] && { echo "no pgpass" >&2; exit 1; }
[[ "\$(stat -c %a "\$PGPASSFILE")" == "600" ]] || { echo "pgpass not 0600" >&2; exit 1; }
for ((i=1;i<=\$#;i++)); do [[ "\${!i}" == "--file" ]] && { j=\$((i+1)); f="\${!j}"; }; done
if [[ -f "$T/flags/dump_empty" ]]; then : > "\$f"; else echo "PGDMP fake" > "\$f"; fi
STUB
  cat > "$T/bin/pg_restore" <<STUB
#!/usr/bin/env bash
[[ -f "$T/flags/dump_notables" ]] && { echo "; no data"; exit 0; }
printf '1; 0 1 TABLE DATA public users lifeos\n2; 0 2 TABLE DATA public tasks lifeos\n'
STUB
  printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/pg_isready"
  cat > "$T/bin/sudo" <<STUB
#!/usr/bin/env bash
[[ "\$1" == "-n" ]] && shift
if [[ "\$1" == "-l" ]]; then [[ -f "$T/flags/no_sudo" ]] && exit 1; exit 0; fi
echo "sudo \$*" >> "$T/calls.log"
exit 0
STUB
  cat > "$T/bin/curl" <<STUB
#!/usr/bin/env bash
url="\${@: -1}"; mode=\$(cat "$T/flags/health" 2>/dev/null || echo ok)
case "\$url" in
  */up) code=200; [[ "\$mode" == "up500" ]] && code=500; ctype=text/html ;;
  */api/user) code=401; ctype="application/json"; [[ "\$mode" == "api500" ]] && { code=500; ctype="text/html"; } ;;
  *) code=200; ctype=text/html ;;
esac
if [[ "\$*" == *content_type* ]]; then printf '%s %s\n' "\$code" "\$ctype"; else printf '%s' "\$code"; fi
STUB
  chmod +x "$T"/bin/*
  # --- git: origin + checkout --------------------------------------------------------------------------------------------------
  git init -q --bare "$T/origin.git"; git -C "$T/origin.git" symbolic-ref HEAD refs/heads/main
  git init -q -b main "$T/seed"; local g=(git -C "$T/seed" -c user.name=t -c user.email=t@t)
  mkdir -p "$T/seed/backend/"{storage,bootstrap/cache,database/migrations} "$T/seed/frontend/public/fonts" "$T/seed/scripts"
  printf '.env\n.env.*\nvendor/\nnode_modules/\nfrontend/dist/\nfrontend/dist.new/\nfrontend/dist.prev/\nfrontend/public/fonts/*.woff2\n' > "$T/seed/.gitignore"
  touch "$T/seed/backend/artisan" "$T/seed/backend/storage/.gitkeep" "$T/seed/backend/bootstrap/cache/.gitkeep" "$T/seed/frontend/public/fonts/.gitkeep"
  echo '{}' > "$T/seed/backend/composer.lock"; echo '{}' > "$T/seed/frontend/package-lock.json"; echo 'v1' > "$T/seed/frontend/app.txt"
  "${g[@]}" add -A; "${g[@]}" commit -q -m c1; C1=$("${g[@]}" rev-parse HEAD)
  echo 'v2' > "$T/seed/frontend/app.txt"; touch "$T/seed/backend/database/migrations/2026_01_01_000000_new_table.php"
  "${g[@]}" add -A; "${g[@]}" commit -q -m c2; C2=$("${g[@]}" rev-parse HEAD)
  echo '{"v":3}' > "$T/seed/backend/composer.lock"; echo 'v3' > "$T/seed/frontend/app.txt"
  "${g[@]}" add -A; "${g[@]}" commit -q -m c3; C3=$("${g[@]}" rev-parse HEAD)
  "${g[@]}" remote add origin "$T/origin.git"; "${g[@]}" push -q origin main
  "${g[@]}" checkout -q -b side "$C1"; echo side > "$T/seed/side.txt"; "${g[@]}" add -A; "${g[@]}" commit -q -m side; SIDE=$("${g[@]}" rev-parse HEAD)
  "${g[@]}" push -q origin side; "${g[@]}" checkout -q main
  git clone -q "$T/origin.git" "$T/app"; git -C "$T/app" reset -q --keep "$C1"   # the server starts on c1 (a plain clone, not --hard)
  echo 'APP_ENV=production
DB_CONNECTION=pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=lifeos
DB_USERNAME=lifeos
DB_PASSWORD="se:cr\et"' > "$T/app/backend/.env"
  mkdir -p "$T/app/frontend/dist"; echo old > "$T/app/frontend/dist/index.html"; mkdir -p "$T/app/backend/vendor" "$T/app/frontend/node_modules"
  : > "$T/calls.log"; : > "$T/order.log"
  chown -R nobody:nogroup "$T" 2>/dev/null || true; chmod -R a+rwX "$T"
}
# NVM like the deploy user's: sourcing nvm.sh defines `nvm`; `nvm use 24` puts a Node 24 first on PATH. flags: nvm_no_node (not installed), nvm_node (version it provides).
enable_nvm() {
  mkdir -p "$T/home/.nvm" "$T/nvm-bin"
  cat > "$T/home/.nvm/nvm.sh" <<NVM
nvm() { if [ "\$1" = use ]; then [ -f "$T/flags/nvm_no_node" ] && return 3; PATH="$T/nvm-bin:\$PATH"; export PATH; return 0; fi; return 0; }
NVM
  cat > "$T/nvm-bin/node" <<NODE
#!/usr/bin/env bash
cat "$T/flags/nvm_node" 2>/dev/null || echo v24.22.2
NODE
  chmod -R a+rwX "$T/home" "$T/nvm-bin"; chmod a+x "$T/nvm-bin/node"
}
teardown() { [[ -n "$T" ]] && rm -rf "$T"; T=""; }

run() { # run <args…>; sets OUT file and RC
  OUT="$T/out.txt"
  as_deployer env PATH="$T/bin:$PATH" HOME="$T/home" APP_DIR="$T/app" STATE_DIR="$T/state" EXPECT_USER="$(as_deployer id -un)" APP_URL=https://example.test \
    HEALTH_RETRIES=2 HEALTH_DELAY=0 "$SCRIPT" "$@" > "$OUT" 2>&1
  RC=$?
}
head_sha() { git -C "$T/app" rev-parse HEAD; }

echo "== static checks"
check "bash -n deploy-production.sh" bash -n "$SCRIPT"
check "bash -n deploy-ssh-entrypoint.sh" bash -n "$ENTRY"
if command -v shellcheck >/dev/null; then check "shellcheck (all scripts)" shellcheck -x -S warning "$SCRIPT" "$ENTRY" "${BASH_SOURCE[0]}"; else echo "  skip shellcheck (not installed)"; fi
check "script never uses reset --hard / clean / add (comments ignored)" bash -c "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nE 'reset --hard|git (.* )?clean|git (.* )?add |git_app (clean|add)'"
check "script never touches docker / n8n / postgres service (comments ignored)" bash -c "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nEi 'docker|n8n|systemctl (restart|stop|reload) postgres'"

echo "== argument and safety checks"
setup
run deploy --sha abc;                          check "short sha rejected" test $RC -ne 0
run deploy;                                     check "missing sha rejected" test $RC -ne 0
run bogus;                                      check "unknown mode rejected" test $RC -ne 0
run deploy --sha "$SIDE";                       check "commit not on origin/main refused" test $RC -ne 0; check "  …with a clear message" has "not part of origin/main" "$OUT"
check "…and HEAD unchanged" test "$(head_sha)" = "$C1"
if [[ "$(id -u)" -eq 0 ]]; then
  OUT="$T/out.txt"; env PATH="$T/bin:$PATH" HOME="$T/home" APP_DIR="$T/app" STATE_DIR="$T/state" EXPECT_USER=root "$SCRIPT" check > "$OUT" 2>&1; RC=$?
  check "running as root refused" test $RC -ne 0; check "  …with a clear message" has "refusing to run as root" "$OUT"
fi
echo "x" >> "$T/app/frontend/app.txt"; run deploy --sha "$C2"
check "dirty tracked file refused" test $RC -ne 0; check "  …with a clear message" has "unexpected local changes" "$OUT"
check "…and HEAD unchanged" test "$(head_sha)" = "$C1"
git -C "$T/app" checkout -q -- frontend/app.txt; touch "$T/app/stray-file.txt"; run deploy --sha "$C2"
check "unexpected untracked file refused" test $RC -ne 0
rm -f "$T/app/stray-file.txt"; touch "$T/app/backend/.env.local" "$T/app/frontend/public/fonts/Thmanyah.woff2"; run check
check "ignored files (.env*, fonts, dist) do not count as dirty" test $RC -eq 0
git -C "$T/app" checkout -q -b other; run check; check "wrong branch refused" test $RC -ne 0; git -C "$T/app" checkout -q main
touch "$T/flags/no_sudo"; run check; check "missing sudo rule refused" test $RC -ne 0; rm "$T/flags/no_sudo"
( flock 9; sleep 3 ) 9>"$T/state/deploy.lock" & sleep 0.5; run deploy --sha "$C2"
check "concurrent deploy refused" test $RC -ne 0; check "  …with a clear message" has "already running" "$OUT"; wait
teardown

echo "== dry run"
setup; run deploy --sha "$C2" --dry-run
check "dry run succeeds" test $RC -eq 0
check "dry run changes nothing (HEAD, no install/build/migrate/reload)" bash -c "[ '$(head_sha)' = '$C1' ] && ! grep -vE 'dry-run|migrate:status|^npm -v ' '$T/calls.log' | grep -qE 'composer|npm|migrate|systemctl'"
check "dry run reports the vendor/lock state" has "pending package operation" "$OUT"
check "dry run lists the migration file" has "migration file changed" "$OUT"
teardown

echo "== release without migrations"
setup; run deploy --sha "$C2"
check "deploy succeeds" test $RC -eq 0
check "HEAD is the target" test "$(head_sha)" = "$C2"
check "composer install --no-dev (never update)" bash -c "grep -q 'composer install --no-dev' '$T/calls.log' && ! grep -q 'composer update' '$T/calls.log'"
check "frontend built into dist.new then swapped" bash -c "grep -q $C2 '$T/app/frontend/dist/index.html' && [ -f '$T/app/frontend/dist.prev/index.html' ] && [ ! -d '$T/app/frontend/dist.new' ]"
check "no backup and no migrate without pending migrations" bash -c "! grep -qE 'BACKUP|MIGRATE' '$T/order.log'"
check "caches rebuilt" has "artisan optimize " "$T/calls.log"
check "php-fpm reloaded and queue restarted via sudo" bash -c "grep -q 'systemctl reload php8.3-fpm' '$T/calls.log' && grep -q 'systemctl restart lifeos-queue' '$T/calls.log'"
check "no docker/postgres/n8n restart" bash -c "! grep -Ei 'docker|postgres|n8n' '$T/calls.log'"
check "history + current.sha written" bash -c "grep -q 'result=ok' '$T/state/history.log' && [ \"\$(cat '$T/state/current.sha')\" = '$C2' ]"
check "ignored local files survived (.env, fonts)" test -f "$T/app/backend/.env"
check "no password in the log" bash -c "! grep -q 'cr.et' '$T/state/deploy.log' '$OUT'"
teardown

echo "== first deploy: HEAD already equals the target (server on the current commit, vendor/ and dist/ behind)"
setup; run deploy --sha "$C1"
check "HEAD == target succeeds" test $RC -eq 0
check "…says so" has "Already at" "$OUT"
check "…still runs composer install --no-dev (repairs a vendor/ that lags composer.lock)" has "composer install --no-dev --no-interaction" "$T/calls.log"
check "…rebuilds a dist/ that has no build marker (npm ci + build), swaps it, writes the marker" bash -c "grep -q 'npm ci' '$T/calls.log' && grep -q $C1 '$T/app/frontend/dist/index.html' && [ -s '$T/app/frontend/dist/.lifeos-frontend-tree' ] && [ \"\$(cat '$T/app/frontend/dist/.lifeos-frontend-tree')\" = \"\$(git -C '$T/app' rev-parse $C1:frontend)\" ]"
check "…no backup/migrate without pending migrations; php-fpm/queue still refreshed" bash -c "! grep -qE 'BACKUP|MIGRATE' '$T/order.log' && grep -q 'systemctl reload' '$T/calls.log' && grep -q 'systemctl restart' '$T/calls.log'"
: > "$T/calls.log"; run deploy --sha "$C1"
check "second run is idempotent: dist kept (marker matches), composer install still runs" bash -c "[ $RC -eq 0 ] && ! grep -qE 'npm (ci|run)' '$T/calls.log' && grep -q 'composer install --no-dev --no-interaction' '$T/calls.log' && grep -q 'keeping it' '$OUT'"
teardown
setup; touch "$T/flags/pending"; run deploy --sha "$C1"
check "HEAD == target with pending migrations: backup strictly before migrate" bash -c "[ $RC -eq 0 ] && [ \"\$(tr '\n' ' ' < '$T/order.log')\" = 'BACKUP MIGRATE ' ]"
teardown

echo "== release with migrations"
setup; touch "$T/flags/pending"; run deploy --sha "$C2"
check "deploy succeeds" test $RC -eq 0
check "backup runs strictly before migrate" bash -c "[ \"\$(tr '\n' ' ' < '$T/order.log')\" = 'BACKUP MIGRATE ' ]"
check "backup file + checksum exist (mode 600)" bash -c "f=\$(ls '$T/state/backups'/lifeos-*.dump) && [ -s \"\$f\" ] && [ -s \"\$f.sha256\" ] && [ \"\$(stat -c %a \"\$f\")\" = 600 ]"
check "temporary pgpass removed" bash -c "! ls '$T/state'/.pgpass.* 2>/dev/null"
teardown

echo "== failure scenarios (production-safe, all stubbed)"
setup; touch "$T/flags/pending" "$T/flags/dump_fails"; run deploy --sha "$C2"
check "pg_dump failure aborts" test $RC -ne 0
check "…migrate never ran" bash -c "! grep -q MIGRATE '$T/order.log'"
check "…code reverted to the previous commit" test "$(head_sha)" = "$C1"
check "…live frontend untouched" bash -c "grep -q old '$T/app/frontend/dist/index.html'"
check "…history says failed-reverted" has "failed-reverted" "$T/state/history.log"
teardown
for flag in dump_empty dump_notables; do
  setup; touch "$T/flags/pending" "$T/flags/$flag"; run deploy --sha "$C2"
  check "unverifiable backup ($flag) blocks migration" bash -c "[ $RC -ne 0 ] && ! grep -q MIGRATE '$T/order.log' && [ '$(head_sha)' = '$C1' ]"; teardown
done
setup; touch "$T/flags/build_fails"; run deploy --sha "$C2"
check "frontend build failure aborts, reverts, keeps old site" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C1' ] && grep -q old '$T/app/frontend/dist/index.html' && [ ! -d '$T/app/frontend/dist.new' ]"
teardown
setup; touch "$T/flags/pending" "$T/flags/migrate_fails"; run deploy --sha "$C2"
check "failed migration: no automatic code revert, backup kept, message points to docs" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C2' ] && ls '$T/state/backups'/lifeos-*.dump >/dev/null && grep -q 'point of no return' '$OUT'"
teardown
setup; echo api500 > "$T/flags/health"; run deploy --sha "$C2"
check "unhealthy API after release exits 3 and says how to roll back" bash -c "[ $RC -eq 3 ] && grep -q 'rollback --sha $C1' '$OUT' && grep -q 'result=unhealthy' '$T/state/history.log'"
teardown
setup; run rollback --sha "$C2"; check "rollback to a newer commit refused (must use deploy)" bash -c "[ $RC -ne 0 ] && grep -q 'use .deploy' '$OUT'"
run deploy --sha "$C2"; run deploy --sha "$C1"
check "deploy to an older commit refused (must use rollback)" bash -c "[ $RC -ne 0 ] && grep -q 'use .rollback' '$OUT'"
teardown

echo "== Node.js: the failed first deploy (system Node 18 first on PATH, NVM Node 24 for the deploy user)"
setup; echo v18.19.1 > "$T/flags/system_node"; enable_nvm; run deploy --sha "$C2"
check "NVM's Node 24 is selected explicitly, so the build succeeds even though /usr/bin/node is 18" test $RC -eq 0
check "…npm ci and the build ran under Node 24, never under 18" bash -c "grep -q 'npm run build.*node=v24.22.2' '$T/calls.log' && ! grep -q 'node=v18' '$T/calls.log'"
check "…the Node in use is logged" has "Node.js v24.22.2" "$OUT"
teardown
setup; echo v18.19.1 > "$T/flags/system_node"; run deploy --sha "$C2"
check "Node 18 and no NVM: refused before anything changes" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C1' ]"
check "…with a clear message" has "Node.js 24 is required" "$OUT"
check "…composer, npm and the build never ran" bash -c "! grep -qE 'composer|npm' '$T/calls.log'"
run check; check "…and 'check' reports the same, so the server can be verified without deploying" test $RC -ne 0
teardown
setup; echo v18.19.1 > "$T/flags/system_node"; enable_nvm; touch "$T/flags/nvm_no_node"; run deploy --sha "$C2"
check "NVM present but Node 24 not installed in it: refused, nothing changed" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C1' ] && ! grep -qE 'composer|npm' '$T/calls.log'"
check "…telling the admin what to run" has "nvm install 24" "$OUT"
teardown
setup; enable_nvm; echo v20.19.0 > "$T/flags/nvm_node"; run deploy --sha "$C2"
check "Any other major (20) is refused as well" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C1' ]"
teardown
setup; run deploy --sha "$C2"
check "A system Node that already is 24 (no NVM) still works" test $RC -eq 0
teardown

echo "== after a failed build: Composer, frontend and PHP are left consistent"
setup; touch "$T/flags/build_fails"; run deploy --sha "$C2"
check "build failure with vendor/ behind composer.lock: reverted to the previous commit" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C1' ]"
check "…composer announced its 18 pending operations before installing" has "18 package operation(s) to apply" "$OUT"
check "…vendor/ matches composer.lock of the restored commit" bash -c "[ \"\$(cat '$T/app/backend/vendor/.lockhash')\" = \"\$(sha256sum '$T/app/backend/composer.lock' | cut -d' ' -f1)\" ]"
check "…the log says so" has "Composer consistent" "$OUT"
check "…the live frontend was never replaced" bash -c "grep -q old '$T/app/frontend/dist/index.html' && [ ! -d '$T/app/frontend/dist.new' ] && grep -q 'Frontend intact' '$OUT'"
check "…PHP-FPM and the queue worker were refreshed because vendor/ had changed" bash -c "grep -q 'systemctl reload' '$T/calls.log' && grep -q 'systemctl restart' '$T/calls.log'"
check "…history records the reverted failure" has "failed-reverted" "$T/state/history.log"
teardown
setup; run deploy --sha "$C2"; : > "$T/calls.log"; touch "$T/flags/build_fails"; run deploy --sha "$C3"
check "failure after a deploy that changed composer.lock: code reverted to the commit that was live" bash -c "[ $RC -ne 0 ] && [ '$(head_sha)' = '$C2' ]"
check "…vendor/ was reinstalled for the restored lock, not left on the failed target's" bash -c "has_line() { grep -q \"\$1\" '$OUT'; }; has_line 'differs from composer.lock after the revert' && has_line 'reinstalling from the lock' && [ \"\$(cat '$T/app/backend/vendor/.lockhash')\" = \"\$(sha256sum '$T/app/backend/composer.lock' | cut -d' ' -f1)\" ]"
teardown
setup; run deploy --sha "$C2"; : > "$T/calls.log"; touch "$T/flags/health"; echo ok > "$T/flags/health"; run deploy --sha "$C3"
check "a later healthy deploy runs composer for the new lock and refreshes PHP once" bash -c "[ $RC -eq 0 ] && grep -c 'systemctl reload' '$T/calls.log' | grep -qx 1"
teardown

echo "== rollback"
setup; run deploy --sha "$C2"; : > "$T/calls.log"; : > "$T/order.log"; touch "$T/flags/pending"; run rollback --sha "$C1"
check "rollback succeeds" test $RC -eq 0
check "code is back on the previous commit" test "$(head_sha)" = "$C1"
check "rollback never migrates or backs up the database" bash -c "! grep -qE 'BACKUP|MIGRATE' '$T/order.log' && ! grep -q 'migrate --force' '$T/calls.log'"
check "frontend rebuilt for the old commit" grep -q "$C1" "$T/app/frontend/dist/index.html"
teardown

echo "== SSH forced command"
setup
cat > "$T/fake-deploy.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*"
STUB
chmod +x "$T/fake-deploy.sh"
ssh_cmd() { SSH_ORIGINAL_COMMAND="$1" DEPLOY_SCRIPT="$T/fake-deploy.sh" "$ENTRY" 2>&1; }
check "deploy <sha> maps to --sha" test "$(ssh_cmd "deploy $C2")" = "deploy --sha $C2"
check "rollback <sha> dry-run maps to --dry-run" test "$(ssh_cmd "rollback $C1 dry-run")" = "rollback --sha $C1 --dry-run"
check "check allowed" test "$(ssh_cmd check)" = "check"
for evil in "" "bash" "deploy abc" "deploy $C2; id" "deploy $C2 && id" "deploy \$(id)" "check; id" "deploy $C2 --sha $C1" "cat /etc/shadow" "rollback"; do
  ssh_cmd "$evil" > /dev/null; rc=$?
  check "rejects: '${evil:-<empty>}'" test $rc -eq 126
done
teardown

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
