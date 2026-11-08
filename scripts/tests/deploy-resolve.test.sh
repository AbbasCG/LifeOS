#!/usr/bin/env bash
# Offline tests for scripts/deploy-resolve.sh (the decision "which commit may the Deploy workflow ship?") and for the guard rails that
# .github/workflows/deploy.yml must keep. `gh` is replaced by a stub that serves canned JSON fixtures: no network, no GitHub token, no server.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RESOLVE="$ROOT/scripts/deploy-resolve.sh"
WORKFLOW="$ROOT/.github/workflows/deploy.yml"
PASS=0; FAIL=0; T=""
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

S=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa   # the commit under test
N=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb   # a newer commit on main
REPO=AbbasCG/LifeOS

setup() {
  T=$(mktemp -d); mkdir -p "$T/bin" "$T/fx"
  cat > "$T/bin/gh" <<STUB
#!/usr/bin/env bash
# gh api <path> [--jq <expr>] -> serves \$FX/<path with every non-alphanumeric replaced by _>.json
echo "gh \$*" >> "$T/gh.log"
[[ "\$1" == "api" ]] || exit 2
path="\$2"; expr=""; [[ "\${3:-}" == "--jq" ]] && expr="\$4"
f="$T/fx/\$(printf '%s' "\$path" | tr -c 'A-Za-z0-9' '_').json"
[[ -f "\$f" ]] || { echo "gh: HTTP 404 (\$path)" >&2; exit 1; }
if [[ -n "\$expr" ]]; then jq -r "\$expr" "\$f"; else cat "\$f"; fi
STUB
  chmod +x "$T/bin/gh"
}
fx() { printf '%s' "$2" > "$T/fx/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_').json"; }
# Healthy world for commit $1: on main, CI green, still head of main, merged PR, never deployed.
world() {
  local sha="${1:-$S}"
  fx "repos/$REPO/compare/main...$sha" '{"status":"identical"}'
  fx "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&status=success" '{"total_count":1}'
  fx "repos/$REPO/commits/main" "{\"sha\":\"$sha\"}"
  fx "repos/$REPO/commits/$sha/pulls" '[{"merged_at":"2026-01-01T00:00:00Z","base":{"ref":"main"}}]'
  fx "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" '{"workflow_runs":[]}'
}
auto() { # run the resolver as the automatic path; extra args are VAR=value overrides
  rm -f "$T/out" "$T/gh.log"; : > "$T/out"
  env -i PATH="$T/bin:$PATH" HOME="$T" GITHUB_OUTPUT="$T/out" GITHUB_STEP_SUMMARY="$T/sum" REPO="$REPO" EVENT=workflow_run \
    RUN_SHA="$S" RUN_CONCLUSION=success RUN_EVENT=push RUN_BRANCH=main RUN_REPO="$REPO" "$@" bash "$RESOLVE" > "$T/log" 2>&1
}
manual() {
  rm -f "$T/out" "$T/gh.log"; : > "$T/out"
  env -i PATH="$T/bin:$PATH" HOME="$T" GITHUB_OUTPUT="$T/out" GITHUB_STEP_SUMMARY="$T/sum" REPO="$REPO" EVENT=workflow_dispatch "$@" bash "$RESOLVE" > "$T/log" 2>&1
}
val()      { sed -n "s/^$1=//p" "$T/out" | tail -1; }
deploys()  { [[ "$(val skip)" == "false" && "$(val sha)" == "${1:-$S}" ]]; }
skipped()  { [[ "$(val skip)" == "true" && -z "$(val sha)" ]]; }
noapi()    { [[ ! -s "$T/gh.log" ]]; }
logs()     { grep -q -- "$1" "$T/log"; }

echo "== automatic: CI succeeded on the merge commit"
setup; world
auto;  rc=$?
check "green push-CI on main, still head, merged PR, not deployed yet -> deploy exactly that SHA" bash -c "[[ $rc -eq 0 ]]" 
check "…output is the full SHA, action deploy, skip=false" deploys
check "…and the plan is written to the job summary" grep -q "$S" "$T/sum"

echo "== automatic: CI did not succeed / is not the right run"
for c in failure cancelled skipped timed_out neutral ""; do
  auto RUN_CONCLUSION="$c"; rc=$?
  check "CI conclusion '${c:-empty}' -> nothing deployed (exit 0, skip)" bash -c "[[ $rc -eq 0 ]]" 
  check "…skip=true and no SHA" skipped
  check "…without asking GitHub anything" noapi
done
# A re-run that fails after an earlier green attempt (CI #153 went red three times): the run that triggered us decides, GitHub's history of older greens does not.
world; auto RUN_CONCLUSION=failure
check "a failed CI run is skipped even though an earlier green run exists for the same SHA" skipped
check "…and the older green run is not even looked up" noapi
auto RUN_EVENT=pull_request;       check "CI run of a pull_request -> skip" skipped
auto RUN_BRANCH=feature;           check "CI run of another branch -> skip" skipped
auto RUN_REPO=someone/LifeOS;      check "CI run from a fork -> skip" skipped

echo "== automatic: old CI finishing after a newer commit"
world; fx "repos/$REPO/commits/main" "{\"sha\":\"$N\"}"
auto;  check "SHA is no longer the head of main -> skip, the newer commit deploys itself" skipped
logs "no longer the head" && ok "…and says why" || bad "…and says why"
world; fx "repos/$REPO/compare/main...$S" '{"status":"ahead"}'
auto; rc=$?; check "SHA not on main (ahead/diverged) -> refused" bash -c "[[ $rc -ne 0 ]]"
check "…nothing is output as deployable" bash -c "! grep -q '^skip=false' '$T/out'"

echo "== automatic: CI must have passed on that exact SHA"
world; fx "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$S&event=push&status=success" '{"total_count":0}'
auto; rc=$?; check "no successful CI run for the SHA -> refused" bash -c "[[ $rc -ne 0 ]]"
logs "untested commit" && ok "…and says so" || bad "…and says so"

echo "== automatic: only commits that came through a merged pull request"
world; fx "repos/$REPO/commits/$S/pulls" '[]'
auto;  check "direct push to main (no PR) -> skip" skipped
world; fx "repos/$REPO/commits/$S/pulls" '[{"merged_at":null,"base":{"ref":"main"}}]'
auto;  check "only an unmerged PR -> skip" skipped
world; fx "repos/$REPO/commits/$S/pulls" '[{"merged_at":"2026-01-01T00:00:00Z","base":{"ref":"develop"}}]'
auto;  check "merged into another base branch -> skip" skipped

echo "== automatic: duplicate and repeated events"
world; fx "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" "{\"workflow_runs\":[{\"display_title\":\"Deploy $S\"}]}"
auto;  check "the same SHA already deployed successfully -> skip (re-delivered event / re-run CI)" skipped
logs "already deployed" && ok "…and says so" || bad "…and says so"
world; fx "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" "{\"workflow_runs\":[{\"display_title\":\"Deploy $S dry-run\"}]}"
auto;  check "a successful DRY RUN of the SHA does not count as deployed" deploys
world; fx "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" "{\"workflow_runs\":[{\"display_title\":\"Deploy $S rollback\"}]}"
auto;  check "a successful ROLLBACK run does not count as deployed" deploys
world; fx "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" "{\"workflow_runs\":[{\"display_title\":\"Deploy $N\"}]}"
auto;  check "a deploy of ANOTHER SHA does not block this one" deploys
world; auto; first=$(val sha); auto; second=$(val sha)
check "two identical events (nothing deployed in between) both resolve to the same SHA" bash -c "[[ '$first' == '$S' && '$second' == '$S' ]]"

echo "== automatic: malformed input and API failure fail closed"
for bad_sha in "abc123" "${S^^}" "${S}0" "${S:0:39};touch /tmp/pwned" '$(id)' ""; do
  world; auto RUN_SHA="$bad_sha"; rc=$?
  check "RUN_SHA '${bad_sha:0:20}' -> refused" bash -c "[[ $rc -ne 0 ]]"
  check "…before any API call" noapi
done
setup; world; rm -f "$T/fx/"*commits_main*.json
auto; rc=$?; check "API error while reading the head of main -> job fails, nothing deployable" bash -c "[[ $rc -ne 0 ]] && ! grep -q '^skip=false' '$T/out'"
setup; world; rm -f "$T/fx/"*pulls*.json
auto; rc=$?; check "API error while reading the pull request -> job fails, nothing deployable" bash -c "[[ $rc -ne 0 ]] && ! grep -q '^skip=false' '$T/out'"
setup; world; rm -f "$T/fx/"*deploy_yml*.json
auto; rc=$?; check "API error while reading previous deploys -> job fails, nothing deployable" bash -c "[[ $rc -ne 0 ]] && ! grep -q '^skip=false' '$T/out'"
auto EVENT=push 2>/dev/null; rc=$?; check "unsupported event -> refused" bash -c "[[ $rc -ne 0 ]]"

echo "== manual deployment and rollback keep working (no AUTO_DEPLOY needed)"
setup; world
manual INPUT_ACTION=deploy INPUT_SHA=""; rc=$?
check "empty sha = current head of main, resolved to its full SHA" bash -c "[[ $rc -eq 0 ]]"; check "…deploys it" deploys
world "$S"; fx "repos/$REPO/commits/main" "{\"sha\":\"$N\"}"
manual INPUT_ACTION=deploy INPUT_SHA="$S"; check "explicit older SHA that is on main and has green CI is allowed (not required to be head)" deploys
fx "repos/$REPO/commits/$S/pulls" '[]'
manual INPUT_ACTION=deploy INPUT_SHA="$S"; check "…also without a merged PR (a human chose it)" deploys
manual INPUT_ACTION=deploy INPUT_SHA="${S^^}"; deploys && ok "uppercase input is normalised" || bad "uppercase input is normalised"
fx "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$S&event=push&status=success" '{"total_count":0}'
manual INPUT_ACTION=deploy INPUT_SHA="$S"; rc=$?; check "manual deploy of a SHA without green CI -> refused" bash -c "[[ $rc -ne 0 ]]"
world; manual INPUT_ACTION=rollback INPUT_SHA=""; rc=$?; check "rollback without a SHA -> refused" bash -c "[[ $rc -ne 0 ]]"
world; manual INPUT_ACTION=rollback INPUT_SHA="$S"; check "rollback to an explicit SHA -> action rollback" bash -c "[[ \"\$(sed -n 's/^action=//p' '$T/out')\" == rollback ]] && grep -q '^skip=false' '$T/out'"
world; manual INPUT_ACTION=rollback INPUT_SHA="abc"; rc=$?; check "rollback with a short SHA -> refused" bash -c "[[ $rc -ne 0 ]]"
world; manual INPUT_ACTION=format-disk INPUT_SHA="$S"; rc=$?; check "unknown action -> refused" bash -c "[[ $rc -ne 0 ]]"
fx "repos/$REPO/commits/$S/pulls" '[{"merged_at":"x","base":{"ref":"main"}}]'
fx "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" "{\"workflow_runs\":[{\"display_title\":\"Deploy $S\"}]}"
manual INPUT_ACTION=deploy INPUT_SHA="$S"; check "manual re-deploy of an already deployed SHA is still possible (human decision)" deploys

echo "== workflow guard rails (.github/workflows/deploy.yml)"
wf() { grep -qE -- "$1" "$WORKFLOW"; }
check "automatic trigger is workflow_run of the CI workflow on main" bash -c "grep -A3 'workflow_run:' '$WORKFLOW' | grep -q 'workflows: \[CI\]' && grep -A4 'workflow_run:' '$WORKFLOW' | grep -q 'branches: \[main\]'"
check "automatic deploys require AUTO_DEPLOY == 'true' (kill switch)" wf "vars.AUTO_DEPLOY == 'true'"
check "…and a successful conclusion, a push event, main, and this repository" bash -c "grep -q \"workflow_run.conclusion == 'success'\" '$WORKFLOW' && grep -q \"workflow_run.event == 'push'\" '$WORKFLOW' && grep -q \"workflow_run.head_branch == 'main'\" '$WORKFLOW' && grep -q 'head_repository.full_name == github.repository' '$WORKFLOW'"
check "manual runs are only accepted from main" wf "github.ref == 'refs/heads/main'"
check "the deploy job runs only when the resolver did not skip" wf "needs.resolve.outputs.skip != 'true'"
check "the deploy job uses the resolver's SHA, not github.sha or a branch name" bash -c "grep -q 'SHA: \${{ needs.resolve.outputs.sha }}' '$WORKFLOW' && ! grep -q 'github.sha' '$WORKFLOW'"
check "deploys are serialised and never cancelled mid-release" bash -c "grep -A2 '^concurrency:' '$WORKFLOW' | grep -q 'group: deploy-production' && grep -A3 '^concurrency:' '$WORKFLOW' | grep -q 'cancel-in-progress: false'"
check "the run title carries the SHA (the duplicate check depends on it)" bash -c "grep -A2 '^run-name:' '$WORKFLOW' | grep -q 'head_sha'"
check "the production environment still gates the SSH job" bash -c "awk '/^  deploy:/{f=1} f' '$WORKFLOW' | grep -q 'name: production'"
check "SSH secrets are referenced only inside the deploy job" bash -c "[[ \$(awk '/^  deploy:/{exit} {print}' '$WORKFLOW' | grep -c 'secrets\\.') -eq 0 ]]"
check "the resolve job is read-only (no contents: write, no environment)" bash -c "r=\$(awk '/^  deploy:/{exit} {print}' '$WORKFLOW'); ! grep -qE 'write|environment:' <<<\"\$r\""
check "the resolver is taken from main, not from the commit being deployed" bash -c "grep -B1 -A3 'actions/checkout@v4' '$WORKFLOW' | grep -q 'ref: main'"
check "SSH stays restricted: strict host key, forced-command shape, no root" bash -c "grep -q 'StrictHostKeyChecking=yes' '$WORKFLOW' && grep -q 'refusing to deploy as root' '$WORKFLOW' && grep -q 'IdentitiesOnly=yes' '$WORKFLOW'"
check "no 'continue-on-error' and no 'git add' in the deploy tooling" bash -c "! grep -rqE 'continue-on-error|git add' '$WORKFLOW' '$RESOLVE'"
check "the resolver never prints secrets or env dumps" bash -c "! tail -n +2 '$RESOLVE' | grep -qE '(^|[^a-z_/])(env|printenv|set -x)( |$)|DEPLOY_SSH_KEY'"

rm -rf "$T"
echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
