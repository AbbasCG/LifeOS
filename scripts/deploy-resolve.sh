#!/usr/bin/env bash
# Decides WHICH commit a "Deploy production" workflow run may ship, or that it must ship nothing. Called by the `resolve` job of
# .github/workflows/deploy.yml; it only reads the GitHub API (no server, no secrets other than the job's GITHUB_TOKEN) and writes
#   sha=<40-hex or empty>   action=deploy|rollback   skip=true|false
# to $GITHUB_OUTPUT. Exit 1 = refused (a human must look); skip=true = nothing to do, on purpose (not an error).
#
# Inputs (environment): REPO, EVENT (workflow_dispatch | workflow_run), and
#   workflow_run (automatic): RUN_SHA, RUN_CONCLUSION, RUN_EVENT, RUN_BRANCH, RUN_REPO
#   workflow_dispatch (manual): INPUT_SHA (may be empty = head of main), INPUT_ACTION (deploy|rollback)
#
# Automatic mode ships a commit only if ALL hold (every check is repeated here even when the workflow's own `if:` already looked):
#   1. the CI run that triggered us succeeded, was a `push` to `main` of this repository;
#   2. the commit is on main and CI also has a successful push run for exactly that SHA (never "whatever HEAD is now");
#   3. the commit is still the head of main - an older CI finishing after a newer commit landed is skipped, the newer commit has its own CI;
#   4. the commit belongs to a merged pull request (a direct push to main is never shipped automatically);
#   5. that exact SHA has not been deployed successfully already (duplicate or re-delivered events).
# Manual mode keeps the previous behaviour (sha empty = head of main; checks 2 only, plus "on main"); rollback needs an explicit SHA.
set -Eeuo pipefail

: "${REPO:?REPO is required}" "${EVENT:?EVENT is required}"
out="${GITHUB_OUTPUT:-/dev/null}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

refuse() { echo "::error::$*"; exit 1; }
skip() {
  echo "::notice::Deploy skipped: $*"
  { echo "sha="; echo "action=deploy"; echo "skip=true"; } >> "$out"
  { echo "### Deploy skipped"; echo "- $*"; } >> "$summary"
  exit 0
}

action="deploy"
if [[ "$EVENT" == "workflow_run" ]]; then
  # (1) The automatic path only ever follows a green push-CI run on main of this very repository.
  [[ "${RUN_CONCLUSION:-}" == "success" ]] || skip "the CI run did not succeed (conclusion: ${RUN_CONCLUSION:-unknown}); a failed CI never deploys"
  [[ "${RUN_EVENT:-}" == "push" && "${RUN_BRANCH:-}" == "main" && "${RUN_REPO:-}" == "$REPO" ]] \
    || skip "the CI run was not a push to main of $REPO (event: ${RUN_EVENT:-?}, branch: ${RUN_BRANCH:-?}, repo: ${RUN_REPO:-?})"
  sha="${RUN_SHA:-}"
elif [[ "$EVENT" == "workflow_dispatch" ]]; then
  action="${INPUT_ACTION:-deploy}"
  [[ "$action" == "deploy" || "$action" == "rollback" ]] || refuse "unknown action '$action'"
  sha="${INPUT_SHA:-}"; sha="${sha,,}"
  if [[ -z "$sha" ]]; then
    [[ "$action" == "deploy" ]] || refuse "rollback needs an explicit sha"
    sha="$(gh api "repos/$REPO/commits/main" --jq .sha)"
  fi
else
  refuse "unsupported event '$EVENT'"
fi

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "sha must be a full 40-character hash (got '${sha:0:12}')"

# (2) On main (identical to, or behind, its head)...
status="$(gh api "repos/$REPO/compare/main...$sha" --jq .status)"
case "$status" in identical|behind) ;; *) refuse "$sha is not on main (compare status: $status)" ;; esac

# ...and CI passed on exactly that commit.
ok="$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&status=success" --jq .total_count)"
[[ "$ok" =~ ^[0-9]+$ && "$ok" -ge 1 ]] || refuse "no successful CI run found for $sha - refusing to deploy an untested commit"

if [[ "$EVENT" == "workflow_run" ]]; then
  # (3) Older CI finishing after a newer commit: that commit is not what main is now, and the newer one gets its own deploy.
  head="$(gh api "repos/$REPO/commits/main" --jq .sha)"
  [[ "$head" == "$sha" ]] || skip "$sha is no longer the head of main ($head); the newer commit is deployed by its own CI run"

  # (4) Only commits that came in through a merged pull request.
  merged="$(gh api "repos/$REPO/commits/$sha/pulls" --jq '[.[] | select(.merged_at != null and .base.ref == "main")] | length')"
  [[ "$merged" =~ ^[0-9]+$ && "$merged" -ge 1 ]] || skip "$sha does not belong to a merged pull request (direct pushes are deployed manually only)"

  # (5) Duplicate / re-delivered event: this SHA already went out successfully (run-name carries the SHA; dry runs and rollbacks do not count).
  done_before="$(gh api "repos/$REPO/actions/workflows/deploy.yml/runs?status=success&per_page=100" \
    --jq "[.workflow_runs[] | select(.display_title | contains(\"$sha\")) | select(.display_title | contains(\"dry-run\") | not) | select(.display_title | contains(\"rollback\") | not)] | length")"
  [[ "$done_before" =~ ^[0-9]+$ ]] || refuse "could not read previous deploy runs"
  [[ "$done_before" -eq 0 ]] || skip "$sha was already deployed successfully (duplicate event)"
fi

{ echo "sha=$sha"; echo "action=$action"; echo "skip=false"; } >> "$out"
{
  echo "### Deploy plan"
  echo "- trigger: \`$EVENT\`"
  echo "- action: \`$action\`"
  echo "- commit: \`$sha\` (on main, CI green)"
} >> "$summary"
