#!/usr/bin/env bash
# Offline tests for scripts/ci-install-chromium-deps.sh: apt-get, curl, npx and sleep are stubs, so no network and no root are needed.
# Covers: healthy default mirror, a dead default mirror with a working fallback (sources rewritten), nothing reachable (fails, no install),
# and a failing install that recovers on a later attempt.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/ci-install-chromium-deps.sh"
PASS=0; FAIL=0; T=""
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

setup() {
  T=$(mktemp -d); mkdir -p "$T/bin"
  printf 'URIs: mirror+file:/etc/apt/apt-mirrors.txt\n' > "$T/ubuntu.sources"
  cat > "$T/bin/apt-get" <<STUB
#!/usr/bin/env bash
echo "apt-get \$*" >> "$T/calls.log"
case "\$*" in
  *--print-uris*) echo "'http://azure.archive.ubuntu.com/ubuntu/pool/universe/f/fonts-unifont/x.deb' x.deb 100 SHA256:0" ;;
esac
exit 0
STUB
  cat > "$T/bin/curl" <<'STUB'
#!/usr/bin/env bash
url="${*: -1}"
# GOOD_HOSTS: space separated host names that answer 206; every other host times out (000, exit 28).
for h in $GOOD_HOSTS; do [[ "$url" == *"//$h/"* ]] && { printf '206'; exit 0; }; done
printf '000'; exit 28
STUB
  cat > "$T/bin/npx" <<STUB
#!/usr/bin/env bash
echo "npx \$*" >> "$T/calls.log"
n=\$(grep -c '^npx ' "$T/calls.log")
[[ "\$n" -gt "\${NPX_FAILS:-0}" ]]
STUB
  printf '#!/usr/bin/env bash\necho "sleep $*" >> "%s/calls.log"\n' "$T" > "$T/bin/sleep"
  chmod +x "$T/bin/"*
}
run() { # run <cache-hit>; uses GOOD_HOSTS / NPX_FAILS from the environment
  PATH="$T/bin:$PATH" CI_SUDO='' CI_APT_CONF="$T/80-ci" CI_APT_SOURCE_FILES="$T/ubuntu.sources" CI_APT_PAUSE=30 \
    bash "$SCRIPT" "$1" > "$T/out.log" 2>&1
  echo $? > "$T/rc"
}
rc() { cat "$T/rc"; }
calls() { grep -c "$1" "$T/calls.log" 2> /dev/null; true; }

echo "ci-install-chromium-deps"

setup; GOOD_HOSTS="azure.archive.ubuntu.com" run false
check "default mirror healthy: succeeds on the first try" test "$(rc)" = 0
check "default mirror healthy: full install on a cache miss" grep -q 'npx playwright install --with-deps chromium' "$T/calls.log"
check "default mirror healthy: sources untouched" grep -q 'mirror+file' "$T/ubuntu.sources"
check "default mirror healthy: no pause" test "$(calls '^sleep')" = 0

setup; GOOD_HOSTS="azure.archive.ubuntu.com" run true
check "cache hit installs only the system libraries" grep -q 'npx playwright install-deps chromium' "$T/calls.log"

setup; GOOD_HOSTS="archive.ubuntu.com" run false
check "dead default, working fallback: succeeds" test "$(rc)" = 0
check "dead default, working fallback: sources point at the working host" grep -q 'URIs: http://archive.ubuntu.com/ubuntu' "$T/ubuntu.sources"

setup; GOOD_HOSTS="" run false
check "nothing reachable: fails" test "$(rc)" = 1
check "nothing reachable: nothing is installed" test "$(calls '^npx')" = 0
check "nothing reachable: bounded retries with growing pauses" test "$(grep '^sleep' "$T/calls.log" | tr '\n' ' ')" = "sleep 30 sleep 60 "
check "nothing reachable: says why, loudly" grep -q '::error::.*could not be installed' "$T/out.log"
check "nothing reachable: names the probed hosts" grep -q 'probe http://archive.ubuntu.com' "$T/out.log"

setup; GOOD_HOSTS="azure.archive.ubuntu.com" NPX_FAILS=2 run false
check "install fails twice then works: succeeds on attempt 3" test "$(rc)" = 0
check "install fails twice then works: three install attempts" test "$(calls '^npx')" = 3

setup; GOOD_HOSTS="azure.archive.ubuntu.com" NPX_FAILS=9 run false
check "install keeps failing: fails after 3 attempts" test "$(rc)" = 1 -a "$(calls '^npx')" = 3

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
