#!/usr/bin/env bash
# LifeOS production deploy — runs ON THE SERVER as the unprivileged deploy user (never root).
#
#   deploy-production.sh deploy   --sha <40-hex> [--dry-run]   fast-forward main to a tested commit and release it
#   deploy-production.sh rollback --sha <40-hex> [--dry-run]   move the CODE back to an earlier commit of main (never touches the database)
#   deploy-production.sh check                                 read-only pre-flight (user, paths, tools, database, git state)
#
# Design rules (see docs/DEPLOYMENT.md): one deploy at a time (flock); only a commit that is already on origin/main; refuses a dirty
# checkout; PostgreSQL is dumped and verified BEFORE any migration, and migrations run only when some are pending; composer/npm install from
# the lock files only; the new frontend is built beside the live one and swapped in with two renames; no Docker, PostgreSQL or n8n restarts;
# no `git reset --hard`, `git clean` or `git add`. Secrets are never printed and never passed on a command line.
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

APP_DIR="${APP_DIR:-/var/www/lifeos}"
EXPECT_USER="${EXPECT_USER:-lifeos}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
APP_URL="${APP_URL:-https://life.softbuild.nl}"
STATE_DIR="${STATE_DIR:-/var/lib/lifeos-deploy}"
BACKUP_DIR="${BACKUP_DIR:-$STATE_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
PHP_FPM_SERVICE="${PHP_FPM_SERVICE:-php8.3-fpm}"
QUEUE_SERVICE="${QUEUE_SERVICE:-lifeos-queue}"
HEALTH_RETRIES="${HEALTH_RETRIES:-10}"
HEALTH_DELAY="${HEALTH_DELAY:-3}"
MIN_PG_CLIENT_MAJOR="${MIN_PG_CLIENT_MAJOR:-16}"

BACKEND="$APP_DIR/backend"
FRONTEND="$APP_DIR/frontend"
LOG_FILE="$STATE_DIR/deploy.log"

MODE=""; TARGET_SHA=""; DRY_RUN=0
PHASE="init"            # init -> pre-migration (safe to revert automatically) -> post-migration (manual decision)
PREV_SHA=""; BACKUP_FILE=""; PGPASS_TMP=""; STARTED_AT=$(date -u +%FT%TZ); HANDLED=0

ts()  { date -u +%FT%TZ; }
log() { printf '%s [%s] %s\n' "$(ts)" "$$" "$*"; }
die() { log "ERROR: $*"; exit 1; }
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# ---------- arguments ----------
[[ $# -ge 1 ]] || usage
MODE="$1"; shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) [[ $# -ge 2 ]] || usage; TARGET_SHA="${2,,}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage ;;
  esac
done
case "$MODE" in
  deploy|rollback) [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha must be a full 40-character commit hash" ;;
  check) ;;
  *) usage ;;
esac

# ---------- logging, cleanup, failure handling ----------
mkdir -p "$STATE_DIR" 2>/dev/null || true
[[ -d "$STATE_DIR" && -w "$STATE_DIR" ]] || { echo "ERROR: state directory $STATE_DIR is missing or not writable for $(id -un)" >&2; exit 1; }
exec > >(tee -a "$LOG_FILE") 2>&1

cleanup() {
  if [[ -n "$PGPASS_TMP" && -f "$PGPASS_TMP" ]]; then rm -f "$PGPASS_TMP"; fi
  rm -rf "$FRONTEND/dist.new"
  return 0
}

record() { printf '%s user=%s mode=%s from=%s to=%s result=%s backup=%s\n' "$(ts)" "$(id -un)" "$MODE" "${PREV_SHA:-none}" "${TARGET_SHA:-none}" "$1" "${BACKUP_FILE:-none}" >> "$STATE_DIR/history.log"; }

# One exit handler covers every failure path: `set -e` aborts AND explicit `die` calls (which `exit 1` without raising ERR).
on_exit() {
  local code=$?
  trap - EXIT ERR
  if [[ $code -ne 0 && $HANDLED -eq 0 ]]; then
    HANDLED=1
    log "FAILED (exit $code) during phase '$PHASE'"
    if [[ "$PHASE" == "pre-migration" && -n "$PREV_SHA" && $DRY_RUN -eq 0 ]]; then
      revert_code || log "WARNING: automatic code revert failed — fix manually: git -C $APP_DIR reset --keep $PREV_SHA"
      record "failed-reverted"
      log "Nothing irreversible happened: the database was not migrated and the live frontend was not swapped."
    elif [[ "$PHASE" == "post-migration" ]]; then
      record "failed-after-migration"
      log "The release had passed the point of no return (migrations/swap). Decide by hand — see docs/DEPLOYMENT.md (Rollback). Pre-migration backup: ${BACKUP_FILE:-none}"
    elif [[ "$PHASE" != "init" ]]; then
      record "failed"
    fi
  fi
  cleanup
  exit "$code"
}
trap 'log "error at line $LINENO"' ERR
trap on_exit EXIT

revert_code() {
  log "Reverting code to $PREV_SHA (git reset --keep: refuses to overwrite local changes)"
  git -C "$APP_DIR" reset --keep "$PREV_SHA"
  if git -C "$APP_DIR" diff --name-only "$TARGET_SHA" "$PREV_SHA" | grep -qE '^backend/composer\.(lock|json)$'; then
    (cd "$BACKEND" && composer install --no-dev --no-interaction --no-progress --prefer-dist --optimize-autoloader) || return 1
  fi
}

# ---------- helpers ----------
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
env_value() { # read KEY from backend/.env without sourcing it (never echoed)
  local v; v=$(grep -E "^$1=" "$BACKEND/.env" | tail -n1 | cut -d= -f2- || true)
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
git_app() { git -C "$APP_DIR" "$@"; }

# ---------- pre-flight (read-only) ----------
preflight() {
  log "Pre-flight: user, paths, tools"
  [[ "$(id -u)" -ne 0 ]] || die "refusing to run as root; use the unprivileged deploy user ($EXPECT_USER)"
  [[ "$(id -un)" == "$EXPECT_USER" ]] || die "must run as '$EXPECT_USER' (current: $(id -un))"
  [[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout"
  [[ -f "$BACKEND/artisan" && -f "$BACKEND/composer.lock" && -f "$FRONTEND/package-lock.json" ]] || die "backend/frontend layout not found under $APP_DIR"
  [[ -f "$BACKEND/.env" ]] || die "$BACKEND/.env is missing (it is never in Git; create it on the server)"
  [[ -w "$BACKEND/storage" && -w "$BACKEND/bootstrap/cache" ]] || die "storage/ and bootstrap/cache must be writable by $EXPECT_USER"
  [[ -w "$APP_DIR" && -w "$FRONTEND" ]] || die "$FRONTEND must be writable by $EXPECT_USER (dist is built beside the live copy)"
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  [[ -w "$BACKUP_DIR" ]] || die "backup directory $BACKUP_DIR is not writable"
  if ! command -v node >/dev/null 2>&1 && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    set +u; # shellcheck disable=SC1090,SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1; nvm use --silent default >/dev/null 2>&1 || true; set -u
  fi
  for c in git php composer node npm curl flock pg_dump pg_restore pg_isready sha256sum sudo; do need "$c"; done
  local pgmajor; pgmajor=$(pg_dump --version | grep -oE '[0-9]+' | head -n1)
  (( pgmajor >= MIN_PG_CLIENT_MAJOR )) || die "pg_dump $pgmajor is older than the server (need >= $MIN_PG_CLIENT_MAJOR): install postgresql-client-$MIN_PG_CLIENT_MAJOR"
  [[ "$(env_value DB_CONNECTION)" == "pgsql" ]] || die "DB_CONNECTION is not pgsql in backend/.env"
  pg_isready -q -h "$(env_value DB_HOST)" -p "$(env_value DB_PORT)" || die "PostgreSQL is not reachable at $(env_value DB_HOST):$(env_value DB_PORT) from the host (the container must publish 127.0.0.1:<port>)"
  sudo -n -l "/usr/bin/systemctl" reload "$PHP_FPM_SERVICE" >/dev/null 2>&1 || die "sudo rule missing: $EXPECT_USER may not 'systemctl reload $PHP_FPM_SERVICE' (see docs/DEPLOYMENT.md)"
  sudo -n -l "/usr/bin/systemctl" restart "$QUEUE_SERVICE" >/dev/null 2>&1 || die "sudo rule missing: $EXPECT_USER may not 'systemctl restart $QUEUE_SERVICE'"
  [[ -d "$FRONTEND/public/fonts" ]] || log "WARNING: frontend/public/fonts is missing — the app falls back to Inter (licensed Thmanyah files are never in Git)"
  log "Pre-flight ok"
}

git_state() {
  log "Git: branch, cleanliness, target commit"
  local branch; branch=$(git_app rev-parse --abbrev-ref HEAD)
  [[ "$branch" == "$BRANCH" ]] || die "checkout is on '$branch', expected '$BRANCH'"
  local dirty; dirty=$(git_app status --porcelain)
  [[ -z "$dirty" ]] || { printf '%s\n' "$dirty" | head -n 20; die "unexpected local changes in $APP_DIR — not touching them (commit/stash/remove by hand)"; }
  PREV_SHA=$(git_app rev-parse HEAD)
  git_app fetch --quiet "$REMOTE" "$BRANCH"
  if [[ "$MODE" == "check" ]]; then return 0; fi
  git_app cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null || die "commit $TARGET_SHA does not exist after fetch"
  git_app merge-base --is-ancestor "$TARGET_SHA" "$REMOTE/$BRANCH" || die "commit $TARGET_SHA is not part of $REMOTE/$BRANCH — only tested, merged commits may be deployed"
  if [[ "$MODE" == "deploy" ]]; then
    git_app merge-base --is-ancestor "$PREV_SHA" "$TARGET_SHA" || die "$TARGET_SHA is not a fast-forward of the deployed $PREV_SHA; use 'rollback' to go back"
  else
    git_app merge-base --is-ancestor "$TARGET_SHA" "$PREV_SHA" || die "$TARGET_SHA is not an ancestor of the deployed $PREV_SHA; use 'deploy' to go forward"
  fi
  if [[ "$PREV_SHA" == "$TARGET_SHA" ]]; then log "Already at $TARGET_SHA (the release steps still run and health is re-verified)"; fi
}

changed() { git_app diff --name-only "$PREV_SHA" "$TARGET_SHA" -- "$@"; }

# ---------- steps ----------
backup_database() {
  local host port db user pass
  host=$(env_value DB_HOST); port=$(env_value DB_PORT); db=$(env_value DB_DATABASE); user=$(env_value DB_USERNAME); pass=$(env_value DB_PASSWORD)
  [[ -n "$host" && -n "$db" && -n "$user" ]] || die "DB_HOST/DB_DATABASE/DB_USERNAME missing in backend/.env"
  pass="${pass//\\/\\\\}"; pass="${pass//:/\\:}"
  PGPASS_TMP=$(mktemp "$STATE_DIR/.pgpass.XXXXXX"); chmod 600 "$PGPASS_TMP"
  printf '%s:%s:%s:%s:%s\n' "${host//:/\\:}" "${port:-5432}" "${db//:/\\:}" "${user//:/\\:}" "$pass" > "$PGPASS_TMP"
  BACKUP_FILE="$BACKUP_DIR/lifeos-$(date -u +%Y%m%dT%H%M%SZ)-${PREV_SHA:0:12}.dump"
  log "Backing up PostgreSQL '$db' to $BACKUP_FILE"
  PGPASSFILE="$PGPASS_TMP" pg_dump --host "$host" --port "${port:-5432}" --username "$user" --dbname "$db" --format=custom --no-password --file "$BACKUP_FILE" || { rm -f "$BACKUP_FILE"; die "pg_dump failed — no migration will run"; }
  chmod 600 "$BACKUP_FILE"
  [[ -s "$BACKUP_FILE" ]] || die "backup file is empty"
  local entries; entries=$(pg_restore --list "$BACKUP_FILE" | grep -c 'TABLE DATA' || true)
  (( entries > 0 )) || die "backup does not list any table data — refusing to migrate"
  sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"; chmod 600 "$BACKUP_FILE.sha256"
  log "Backup verified: $(stat -c %s "$BACKUP_FILE") bytes, $entries tables, $(cut -c1-16 "$BACKUP_FILE.sha256")…"
  # Retention: keep the newest $BACKUP_KEEP dumps (only files this script created).
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/lifeos-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while IFS= read -r old; do rm -f -- "$old" "$old.sha256"; done || true
}

health_check() {
  log "Health checks against $APP_URL"
  local i code ctype
  for ((i = 1; i <= HEALTH_RETRIES; i++)); do
    code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$APP_URL/up" 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && break
    log "  /up -> $code (attempt $i/$HEALTH_RETRIES)"; sleep "$HEALTH_DELAY"
  done
  [[ "$code" == "200" ]] || return 1
  # A signed-out API request must be a clean 401 JSON (never 500): proves routing, sessions, the database-backed guard and the JSON handler.
  IFS=' ' read -r code ctype < <(curl -sS -o /dev/null -m 10 -w '%{http_code} %{content_type}\n' "$APP_URL/api/user" 2>/dev/null || echo "000 none")
  [[ "$code" == "401" && "$ctype" == application/json* ]] || { log "  /api/user -> $code ($ctype), expected 401 application/json"; return 1; }
  code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$APP_URL/" 2>/dev/null || echo 000)
  [[ "$code" == "200" ]] || { log "  / -> $code, expected 200"; return 1; }
  log "Health checks ok (/up 200, /api/user 401 JSON, / 200)"
}

main_deploy() {
  local composer_changed npm_changed frontend_changed
  composer_changed=$(changed backend/composer.lock backend/composer.json | wc -l)
  npm_changed=$(changed frontend/package-lock.json frontend/package.json | wc -l)
  frontend_changed=$(changed frontend ':(exclude)frontend/e2e' | wc -l)
  [[ -d "$BACKEND/vendor" ]] || composer_changed=1
  [[ -d "$FRONTEND/node_modules" ]] || npm_changed=1
  [[ -f "$FRONTEND/dist/index.html" ]] || frontend_changed=1

  log "Plan: $MODE ${PREV_SHA:0:12} -> ${TARGET_SHA:0:12} | composer:$((composer_changed > 0)) npm:$((npm_changed > 0)) frontend-build:$((frontend_changed > 0))"
  git_app log --oneline --no-decorate "$PREV_SHA..$TARGET_SHA" 2>/dev/null | head -n 20 || true
  if (( DRY_RUN )); then
    log "Dry run: stopping here. Nothing was changed (the fetch only updated remote-tracking refs)."
    if [[ "$MODE" == "deploy" ]]; then changed backend/database/migrations | sed 's/^/  migration file changed: /' || true; fi
    return 0
  fi

  PHASE="pre-migration"
  log "Moving $BRANCH to $TARGET_SHA"
  if [[ "$MODE" == "deploy" ]]; then git_app merge --ff-only --quiet "$TARGET_SHA"; else git_app reset --keep --quiet "$TARGET_SHA"; fi
  [[ "$(git_app rev-parse HEAD)" == "$TARGET_SHA" ]] || die "checkout did not land on $TARGET_SHA"

  log "composer install (from composer.lock, no dev, no update)"
  (cd "$BACKEND" && composer install --no-dev --no-interaction --no-progress --prefer-dist --optimize-autoloader)

  if (( frontend_changed > 0 )); then
    if (( npm_changed > 0 )); then log "npm ci"; (cd "$FRONTEND" && npm ci --no-audit --no-fund); fi
    log "Building frontend into dist.new (the live dist is untouched until the swap)"
    rm -rf "$FRONTEND/dist.new"
    (cd "$FRONTEND" && LIFEOS_BUILD_ID="$TARGET_SHA" npm run build -- --outDir dist.new --emptyOutDir)
    [[ -f "$FRONTEND/dist.new/index.html" ]] || die "frontend build produced no index.html"
  else
    log "No frontend changes: keeping the current dist"
  fi

  local pending_out pending=0
  if [[ "$MODE" == "deploy" ]]; then
    pending_out=$(cd "$BACKEND" && php artisan migrate:status --pending --no-interaction --no-ansi 2>&1) || { printf '%s\n' "$pending_out" | head -n 10; die "cannot read the migration status (database unreachable?)"; }
    grep -q 'No pending migrations' <<<"$pending_out" || pending=1
  else
    log "Rollback: code only — the database is never migrated or rolled back by this script"
  fi

  if (( pending )); then
    log "Pending migrations detected:"; printf '%s\n' "$pending_out" | grep -iE 'pending' | head -n 20 || true
    backup_database
    PHASE="post-migration"
    log "php artisan migrate --force"
    (cd "$BACKEND" && php artisan migrate --force --no-interaction)
  else
    log "No pending migrations: skipping backup and migrate"
  fi
  PHASE="post-migration"

  if [[ -d "$FRONTEND/dist.new" ]]; then
    log "Swapping frontend/dist"
    rm -rf "$FRONTEND/dist.prev"
    if [[ -d "$FRONTEND/dist" ]]; then mv "$FRONTEND/dist" "$FRONTEND/dist.prev"; fi
    if ! mv "$FRONTEND/dist.new" "$FRONTEND/dist"; then
      # Never leave the site without a frontend: put the previous build back before failing.
      if [[ -d "$FRONTEND/dist.prev" ]]; then mv "$FRONTEND/dist.prev" "$FRONTEND/dist"; fi
      die "could not move dist.new into place; previous frontend restored"
    fi
  fi

  log "Rebuilding Laravel caches"
  (cd "$BACKEND" && php artisan optimize:clear --no-interaction && php artisan optimize --no-interaction)
  log "Reloading $PHP_FPM_SERVICE and restarting $QUEUE_SERVICE"
  sudo -n /usr/bin/systemctl reload "$PHP_FPM_SERVICE"
  sudo -n /usr/bin/systemctl restart "$QUEUE_SERVICE"

  if ! health_check; then
    HANDLED=1; record "unhealthy"
    log "UNHEALTHY after release. The previous frontend is kept in frontend/dist.prev. Rollback: scripts/deploy-production.sh rollback --sha $PREV_SHA  (code only; see docs/DEPLOYMENT.md for the database)."
    exit 3
  fi
  printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/current.sha"
  record "ok"
  log "DONE: $MODE to $TARGET_SHA"
}

# ---------- run ----------
log "=== LifeOS $MODE ${TARGET_SHA:+$TARGET_SHA }(started $STARTED_AT, user $(id -un), dry-run=$DRY_RUN) ==="
preflight
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die "another deploy is already running (lock: $STATE_DIR/deploy.lock)"
git_state
if [[ "$MODE" == "check" ]]; then log "Check ok: HEAD ${PREV_SHA:0:12} on $BRANCH, clean"; exit 0; fi
main_deploy
