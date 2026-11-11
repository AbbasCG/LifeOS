#!/usr/bin/env bash
# Installs the OS libraries Chromium needs on a GitHub runner (and the browser itself on a cache miss), and fails FAST with a clear
# reason when the Ubuntu package servers cannot be reached.
#
# Why this exists (CI runs 205 and PR 92): `apt-get update` could succeed (the small index files came through) while every package
# download from the runner's default mirror timed out, so each browser job sat for ~15 minutes in apt and then failed before any test ran.
# So this script (1) probes with a REAL package download, not just an index file, (2) tries the official Ubuntu archive hosts, in order,
# and uses the first one that actually serves a package, (3) retries a bounded number of times with a pause, (4) prints what it saw for
# every host, and (5) exits non-zero when nothing works. It never skips packages and never lets tests run on a half-installed browser.
#
# Usage: ci-install-chromium-deps.sh <cache-hit: true|false>   (run from the frontend/ directory)
# Environment (tests set these): CI_APT_ATTEMPTS (3), CI_APT_PAUSE (30, seconds, multiplied by the attempt number), CI_APT_INSTALL_TIMEOUT (300).
set -uo pipefail

CACHE_HIT="${1:-false}"
ATTEMPTS="${CI_APT_ATTEMPTS:-3}"
PAUSE="${CI_APT_PAUSE:-30}"
INSTALL_TIMEOUT="${CI_APT_INSTALL_TIMEOUT:-300}"
PROBE_PKG="${CI_APT_PROBE_PKG:-fonts-unifont}"   # one of the packages Playwright's install-deps pulls in (a few MB)
SUDO="${CI_SUDO-sudo}"
# shellcheck disable=SC2206
SUDO_CMD=($SUDO)

# Official hosts only. The first is whatever the runner uses today (found from the probe package's own URL); these follow it.
FALLBACK_BASES=(
  "http://azure.archive.ubuntu.com/ubuntu"
  "http://archive.ubuntu.com/ubuntu"
  "https://archive.ubuntu.com/ubuntu"
)

log() { printf '%s\n' "$*"; }

# Quick, bounded apt behaviour: give up on a dead server fast instead of after minutes.
configure_apt() {
  printf 'Acquire::Retries "2";\nAcquire::http::Timeout "15";\nAcquire::https::Timeout "15";\n' | "${SUDO_CMD[@]}" tee "${CI_APT_CONF:-/etc/apt/apt.conf.d/80-ci-network}" > /dev/null
}

# Prints the first download URL apt would use for the probe package ("" when it cannot tell).
probe_uri() {
  "${SUDO_CMD[@]}" apt-get update -qq > /dev/null 2>&1 || true
  apt-get --print-uris -qq download "$PROBE_PKG" 2> /dev/null | sed -n "s/^'\([^']*\)'.*/\1/p" | head -n 1
}

# 0 when $1 serves real bytes of a package within a few seconds.
serves_package() {
  local url="$1" code
  code=$(curl -sS -o /dev/null -r 0-1023 --connect-timeout 5 --max-time 12 -w '%{http_code}' "$url" 2> /dev/null) || code="000"
  log "    probe $url -> HTTP $code"
  [[ "$code" == "200" || "$code" == "206" ]]
}

# Sets CHOSEN_BASE (empty = keep the runner's default mirror) and returns 0 when some official host can serve the package.
choose_mirror() {
  local uri rest base current
  CHOSEN_BASE=""
  uri="$(probe_uri)"
  if [[ -z "$uri" ]]; then
    log "  could not work out a package URL for $PROBE_PKG; keeping the runner's default mirror"
    return 0
  fi
  rest="${uri#*/ubuntu/}"
  current="${uri%%/ubuntu/*}/ubuntu"
  log "  runner default: $current"
  if serves_package "$uri"; then
    return 0
  fi
  for base in "${FALLBACK_BASES[@]}"; do
    [[ "$base" == "$current" ]] && continue
    if serves_package "$base/$rest"; then
      CHOSEN_BASE="$base"
      return 0
    fi
  done
  return 1
}

# Points apt's Ubuntu archive entries (not the security ones) at $1, then refreshes the index.
use_mirror() {
  local base="$1" f
  log "  switching apt to $base"
  # shellcheck disable=SC2086
  for f in ${CI_APT_SOURCE_FILES:-/etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list}; do
    [[ -f "$f" ]] || continue
    "${SUDO_CMD[@]}" sed -i -E "s#(mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z0-9.-]*archive\.ubuntu\.com/ubuntu/?)#${base}#g" "$f"
  done
  "${SUDO_CMD[@]}" apt-get update -qq
}

if [[ "$CACHE_HIT" == "true" ]]; then
  install=(npx playwright install-deps chromium)
else
  install=(npx playwright install --with-deps chromium)
fi

configure_apt
for attempt in $(seq 1 "$ATTEMPTS"); do
  log "Attempt $attempt of $ATTEMPTS: checking that the Ubuntu package servers are reachable"
  if choose_mirror; then
    if [[ -n "$CHOSEN_BASE" ]]; then
      use_mirror "$CHOSEN_BASE" || { log "::warning::Refreshing the package index from $CHOSEN_BASE failed"; }
    fi
    if timeout "$INSTALL_TIMEOUT" "${install[@]}"; then
      exit 0
    fi
    log "::warning::Installing Chromium's system packages failed (attempt $attempt of $ATTEMPTS)"
  else
    log "::warning::No official Ubuntu host served a package (attempt $attempt of $ATTEMPTS)"
  fi
  if [[ "$attempt" -lt "$ATTEMPTS" ]]; then
    sleep $((attempt * PAUSE))
  fi
done
log "::error::Chromium's system packages could not be installed after $ATTEMPTS attempts. See the probe lines above: when every host answers HTTP 000, the runner cannot reach the Ubuntu archives (a GitHub/Ubuntu network problem, not this repository). No test was run."
exit 1
