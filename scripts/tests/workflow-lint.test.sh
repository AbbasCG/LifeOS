#!/usr/bin/env bash
# Offline tests for the workflow lint: the pinned installer (scripts/ci-install-actionlint.sh, with stubbed go and pip) and the lint itself
# (the real workflows must pass; known-bad workflow files must keep being rejected, for the right reason). The lint tests need an actionlint on
# PATH (or ACTIONLINT=/path); in CI the "Workflow lint" step installs it before this runs. A missing actionlint is a FAILURE, never a skip.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
INSTALL="$ROOT/scripts/ci-install-actionlint.sh"
FIX="$HERE/fixtures/workflows"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

# ---- installer, with stubs for go and python3 (no network) ----
T=""
setup() {
  T=$(mktemp -d); mkdir -p "$T/stub" "$T/bin"
  # Stub tools behave per files in $T: go.fail = number of calls that fail first (or "always"), pip.fail likewise; calls are logged.
  cat > "$T/stub/go" <<STUB
#!/usr/bin/env bash
echo "go \$*" >> "$T/calls.log"
n=\$(grep -c '^go ' "$T/calls.log")
f=\$(cat "$T/go.fail" 2>/dev/null || echo 0)
if [[ "\$f" == always ]] || (( n <= f )); then echo "go: boom" >&2; exit 1; fi
printf '#!/usr/bin/env bash\necho v%s\n' "\${GO_VERSION:-1.7.12}" > "\$GOBIN/actionlint"; chmod +x "\$GOBIN/actionlint"
STUB
  cat > "$T/stub/python3" <<STUB
#!/usr/bin/env bash
echo "pip \$*" >> "$T/calls.log"
n=\$(grep -c '^pip ' "$T/calls.log")
f=\$(cat "$T/pip.fail" 2>/dev/null || echo 0)
if [[ "\$f" == always ]] || (( n <= f )); then echo "pip: 504" >&2; exit 1; fi
printf '#!/usr/bin/env bash\necho %s\n' "\${PIP_VERSION_OUT:-1.7.12}" > "$T/bin/actionlint"; chmod +x "$T/bin/actionlint"
STUB
  chmod +x "$T/stub/go" "$T/stub/python3"
  : > "$T/calls.log"
}
run_install() { PATH="$T/stub:$PATH" ACTIONLINT_BIN_DIR="$T/bin" ACTIONLINT_ATTEMPTS="${ATT:-2}" ACTIONLINT_RETRY_DELAY=0 bash "$INSTALL" >"$T/out.log" 2>&1; }
calls() { grep -c "^$1 " "$T/calls.log" || true; }
no_go() { mkdir -p "$T/nogo"; }

echo "== installer: pinned actionlint without a single point of failure"
setup; printf '#!/usr/bin/env bash\necho 1.7.12\n' > "$T/bin/actionlint"; chmod +x "$T/bin/actionlint"
check "the pinned version already in place (cache) is used without any download" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; run_install && [[ \$(calls go) -eq 0 && \$(calls pip) -eq 0 ]]"
rm -rf "$T"

setup
check "go install is the first route and pip is not touched when it works" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; run_install && [[ \$(calls go) -eq 1 && \$(calls pip) -eq 0 ]] && [[ \$(\"$T/bin/actionlint\" -version) == v1.7.12 ]]"
rm -rf "$T"

setup; echo 1 > "$T/go.fail"
check "a failed go download is retried" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; run_install && [[ \$(calls go) -eq 2 && \$(calls pip) -eq 0 ]]"
rm -rf "$T"

setup; echo always > "$T/go.fail"
check "when go keeps failing the pip route takes over (after the retries)" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; run_install && [[ \$(calls go) -eq 2 && \$(calls pip) -eq 1 ]] && grep -q 'installed 1.7.12 with pip' '$T/out.log'"
rm -rf "$T"

setup; echo always > "$T/go.fail"; echo 1 > "$T/pip.fail"
check "pip is retried too" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; run_install && [[ \$(calls pip) -eq 2 ]]"
rm -rf "$T"

setup; echo always > "$T/go.fail"; echo always > "$T/pip.fail"
check "when no route works the install FAILS loudly (the lint is never skipped)" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; ! run_install && grep -q 'is required and is not skipped' '$T/out.log'"
rm -rf "$T"

setup; printf '#!/usr/bin/env bash\necho 1.6.0\n' > "$T/bin/actionlint"; chmod +x "$T/bin/actionlint"
check "a binary of another version is not accepted and is replaced" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; run_install && [[ \$(calls go) -eq 1 ]] && [[ \$(\"$T/bin/actionlint\" -version) == v1.7.12 ]]"
rm -rf "$T"

setup; echo always > "$T/go.fail"
check "a route that yields the wrong version does not count as installed" bash -c "$(declare -f run_install calls); T='$T' INSTALL='$INSTALL'; export PIP_VERSION_OUT=1.6.0; ! run_install"
rm -rf "$T"

check "the installer pins both versions and has no 'curl | sh' or '|| true'" bash -c "grep -q 'ACTIONLINT_VERSION:-1.7.12' '$INSTALL' && grep -q 'ACTIONLINT_PIP_VERSION:-1.7.12.25' '$INSTALL' && ! grep -qE 'curl|wget|\\|\\| *true' '$INSTALL'"

# ---- the lint itself ----
echo "== workflow lint: real workflows pass, bad ones are rejected"
LINT="${ACTIONLINT:-$(command -v actionlint || true)}"
if [[ -z "$LINT" || ! -x "$LINT" ]]; then
  bad "actionlint is installed (set ACTIONLINT=/path or put it on PATH; a missing linter is a failure, not a skip)"
else
  check "the repository's own workflows pass" bash -c "'$LINT' '$ROOT'/.github/workflows/*.yml"
  reject() { # <fixture> <text the report must contain>
    local out; out=$("$LINT" "$FIX/$1" 2>&1); local rc=$?
    [[ $rc -ne 0 ]] && grep -qF -- "$2" <<<"$out"
  }
  check "control: a valid workflow file is accepted" bash -c "'$LINT' '$FIX/valid.yml'"
  check "unknown job key (runs_on) is rejected" reject unknown-key.yml 'runs_on'
  check "a 'needs' naming a missing job is rejected" reject missing-needs.yml 'build-that-does-not-exist'
  check "an expression on an undefined github property is rejected" reject bad-expression.yml 'no_such_property'
  check "the bad fixtures live outside .github/workflows (so the real lint never sees them)" bash -c "! ls '$ROOT'/.github/workflows | grep -qE 'unknown-key|missing-needs|bad-expression|valid'"
fi
check "the CI lint step is not made optional (no continue-on-error, no '|| true' on actionlint)" bash -c "! grep -nE 'continue-on-error|actionlint.*\\|\\| *true' '$ROOT/.github/workflows/ci.yml'"

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
