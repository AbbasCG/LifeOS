#!/usr/bin/env bash
# Installs the pinned actionlint for the "Deploy tooling" CI job, without depending on one download host.
#
# Why: `pip install actionlint-py` builds from source and fetches the binary from GitHub Releases at build time. When that host answered
# 504 (CI #153, three attempts over 25 minutes) the whole CI run went red and nothing could be deployed, although no code was wrong.
# Order, first success wins; every route ends in the same pinned version, which is verified before this script reports success:
#   1. a binary already in place (restored from the CI cache) with exactly the pinned version;
#   2. `go install github.com/rhysd/actionlint/cmd/actionlint@v<version>`  (Go module proxy, checksum database; Go is on the runner image);
#   3. `pip install actionlint-py==<pip version>`                            (GitHub Releases, sha256 pinned by the package).
# Each network route is retried. If none works the script FAILS: the workflow lint is never skipped and never reported as passed.
#
# Environment (all optional): ACTIONLINT_VERSION, ACTIONLINT_PIP_VERSION, ACTIONLINT_BIN_DIR (default ~/.local/bin, also where pip puts it),
# ACTIONLINT_ATTEMPTS (per route, default 3), ACTIONLINT_RETRY_DELAY (seconds, default 20).
set -Eeuo pipefail

VERSION="${ACTIONLINT_VERSION:-1.7.12}"
PIP_VERSION="${ACTIONLINT_PIP_VERSION:-1.7.12.25}"
BIN_DIR="${ACTIONLINT_BIN_DIR:-$HOME/.local/bin}"
ATTEMPTS="${ACTIONLINT_ATTEMPTS:-3}"
DELAY="${ACTIONLINT_RETRY_DELAY:-20}"
log() { echo "actionlint-install: $*"; }

# True when BIN_DIR/actionlint exists and reports exactly the pinned version (a `go install` build prints "v1.7.12", a release binary "1.7.12").
pinned_present() {
  [[ -x "$BIN_DIR/actionlint" ]] || return 1
  local first
  first="$("$BIN_DIR/actionlint" -version 2>/dev/null | head -n 1)" || return 1
  [[ "${first#v}" == "$VERSION" ]]
}

retry() {
  local n=1
  until "$@"; do
    if (( n >= ATTEMPTS )); then return 1; fi
    log "attempt $n of $ATTEMPTS failed; retrying in ${DELAY}s"
    sleep "$DELAY"
    n=$((n + 1))
  done
}

mkdir -p "$BIN_DIR"

if pinned_present; then
  log "version $VERSION is already installed in $BIN_DIR (cache or earlier step)"
  exit 0
fi

if command -v go >/dev/null 2>&1; then
  log "installing $VERSION with go install"
  if retry env GOBIN="$BIN_DIR" go install "github.com/rhysd/actionlint/cmd/actionlint@v$VERSION" && pinned_present; then
    log "installed $VERSION with go install"
    exit 0
  fi
  log "go install did not give version $VERSION"
else
  log "go is not available"
fi

if command -v python3 >/dev/null 2>&1; then
  log "installing $VERSION with pip (actionlint-py $PIP_VERSION)"
  if retry python3 -m pip install --user "actionlint-py==$PIP_VERSION" && pinned_present; then
    log "installed $VERSION with pip"
    exit 0
  fi
  log "pip did not give version $VERSION"
else
  log "python3 is not available"
fi

echo "::error::actionlint $VERSION could not be installed by any route. The workflow lint is required and is not skipped; re-run the job when the download hosts answer."
exit 1
