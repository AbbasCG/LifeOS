#!/usr/bin/env bash
# Offline tests for scripts/release-notes-draft.sh. Everything happens in a temporary git repository with dated merge commits; nothing reaches the network.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/release-notes-draft.sh"
PASS=0; FAIL=0; T=""
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
command -v jq >/dev/null 2>&1 || { echo "jq is required for these tests"; exit 1; }

merge() { # merge <number> <date> <title>: one pull request merged into main on that day
  local n="$1" day="$2" title="$3"
  git checkout -q -b "b$n"; echo "$n" > "f$n.txt"; git add "f$n.txt"
  GIT_AUTHOR_DATE="$day 10:00:00 +0000" GIT_COMMITTER_DATE="$day 10:00:00 +0000" git commit -q -m "work $n"
  git checkout -q main
  GIT_AUTHOR_DATE="$day 12:00:00 +0000" GIT_COMMITTER_DATE="$day 12:00:00 +0000" git merge -q --no-ff -m "Merge pull request #$n from owner/branch-$n" -m "$title" "b$n"
}
setup() {
  T=$(mktemp -d); cd "$T" || exit 1
  git init -q -b main . ; git config user.email t@example.test; git config user.name T
  mkdir -p backend/resources/discovery/releases
  echo init > README; git add README; GIT_AUTHOR_DATE="2026-10-01 09:00:00 +0000" GIT_COMMITTER_DATE="2026-10-01 09:00:00 +0000" git commit -q -m init
  merge 1 2026-10-20 "An old feature"
  printf '{"key":"r-old","date":"2026-11-05"}' > backend/resources/discovery/releases/r-old.json; git add backend; GIT_AUTHOR_DATE="2026-11-05 08:00:00 +0000" GIT_COMMITTER_DATE="2026-11-05 08:00:00 +0000" git commit -q -m "release r-old"
  merge 7 2026-11-05 "Merged on the release day"
  merge 2 2026-11-06 "Quick capture understands Arabic"
  merge 3 2026-11-07 "Fix sign-out losing pending changes"
  merge 4 2026-11-07 "Improve contrast of the priority tiles"
  merge 5 2026-11-08 "Docs: coordination files"
  merge 6 2026-11-08 "CI: shard the browser tests"
}
teardown() { cd / || true; rm -rf "$T"; }
run() { OUT="$T/out.json"; ERR="$T/err.txt"; (cd "$T" && "$SCRIPT" "$@" >"$OUT" 2>"$ERR"); RC=$?; }

echo "== which pull requests, and what type"
setup; run
check "default start is the day after the newest release: only later pull requests" bash -c "[[ \$(jq -r '[.items[]._pr]|sort|join(\",\")' '$OUT') == '2,3,4' ]]"
check "types are guessed from the titles (new / fixed / improved)" bash -c "[[ \$(jq -r '[.items[]|.type]|join(\",\")' '$OUT') == 'new,fixed,improved' ]]"
check "each item starts from the English title" bash -c "jq -e '.items[0].title.en | endswith(\"Quick capture understands Arabic\")' '$OUT' >/dev/null"
check "internal work (docs, CI) is left out and listed on stderr" bash -c "grep -q 'skipped (internal): #5' '$ERR' && grep -q 'skipped (internal): #6' '$ERR' && ! jq -e '.items[]|select(._pr==5 or ._pr==6)' '$OUT' >/dev/null"
check "the release day itself and older pull requests are not included" bash -c "! jq -e '.items[]|select(._pr==1 or ._pr==7)' '$OUT' >/dev/null"
run --since "$(git -C "$T" log --first-parent --merges --format=%H --grep='#1 ' | head -1)"
check "--since a revision starts right after it" bash -c "[[ \$(jq -r '[.items[]._pr]|sort|join(\",\")' '$OUT') == '2,3,4,7' ]]"
teardown

echo "== the draft cannot be shipped by accident"
setup; run
check "valid JSON with the draft key" bash -c "jq -e 'has(\"_draft\") and (.key|endswith(\"-draft\")) and .revision==1' '$OUT' >/dev/null"
check "every text in every language carries the draft marker" bash -c "jq -e '[.title,.summary,(.items[]|.title,.body)] | all(.[]; .ar and .nl and .en and (.ar|contains(\"⟦DRAFT⟧\")) and (.nl|contains(\"⟦DRAFT⟧\")) and (.en|contains(\"⟦DRAFT⟧\")))' '$OUT' >/dev/null"
check "no feature, tour or link is invented" bash -c "! jq -e '.items[]|(has(\"feature\") or has(\"link\"))' '$OUT' >/dev/null"
teardown

echo "== safety of the output file and of the repository"
setup; run --out "$T/backend/resources/discovery/releases/draft.json"
check "writing inside the content folder is refused" bash -c "[[ $RC -eq 2 ]] && grep -q 'must not be written inside' '$ERR' && [[ ! -e '$T/backend/resources/discovery/releases/draft.json' ]]"
mkdir -p "$T/elsewhere"; run --out "$T/elsewhere/draft.json"
check "a file elsewhere is written" bash -c "[[ $RC -eq 0 ]] && jq -e '.items|length==3' '$T/elsewhere/draft.json' >/dev/null"
check "the repository is not changed (no commit, no file in the tree)" bash -c "cd '$T' && [[ -z \"\$(git status --porcelain --ignore-submodules | grep -v '^?? elsewhere/\|^?? out.json\|^?? err.txt')\" ]]"
teardown

echo "== edge cases"
setup; git -C "$T" rm -q backend/resources/discovery/releases/r-old.json; git -C "$T" -c user.email=t@example.test -c user.name=T commit -q -m "drop release"
run
check "no earlier release and no --since: asks for --since" bash -c "[[ $RC -eq 2 ]] && grep -q 'pass --since' '$ERR'"
run --since nonexistent-rev
check "an unknown revision is an error" bash -c "[[ $RC -eq 2 ]] && grep -q 'unknown revision' '$ERR'"
run --since 2026-12-01
check "nothing user-facing since then: nothing is printed and it is not an error" bash -c "[[ $RC -eq 0 && ! -s '$OUT' ]] && grep -q 'nothing to draft' '$ERR'"
teardown
setup
merge 8 2026-11-09 'Fix "quotes", $(touch /tmp/lifeos-draft-pwned) `id` and a \backslash'
rm -f /tmp/lifeos-draft-pwned
run
check "a hostile title stays text: valid JSON, quotes kept, nothing executed" bash -c "jq -e --arg want '\$(touch /tmp/lifeos-draft-pwned)' '.items[]|select(._pr==8)|.title.en|contains(\$want)' '$OUT' >/dev/null && [[ ! -e /tmp/lifeos-draft-pwned ]]"
teardown

echo "== the script itself"
check "reads git only: no network, no push, no commit, no GitHub API" bash -c "! grep -vE '^\s*#' '$SCRIPT' | grep -qE 'curl|wget|gh api|git[^|]* (push|fetch|pull|commit|add|reset|clean|checkout)'"

echo
echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
