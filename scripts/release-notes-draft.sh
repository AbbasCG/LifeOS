#!/usr/bin/env bash
# Drafts the skeleton of a release-notes file (backend/resources/discovery/releases/<key>.json) from the pull requests merged since the last release,
# so a person only has to write the real text. It READS git and nothing else: no network, no GitHub token, no server, no database, no repository change.
#
#   scripts/release-notes-draft.sh [--since <rev|YYYY-MM-DD>] [--until <rev>] [--out <file>]
#
#   --since  where to start: a revision (commits after it) or a date. Default: the date of the newest existing release file.
#   --until  where to stop (default HEAD).
#   --out    write the draft to this file instead of standard output. Refused inside backend/resources/discovery/ (see below).
#
# What it prints is a DRAFT and cannot be shipped by accident:
#   * every text still carries the marker ⟦DRAFT⟧ and the file has a "_draft" key; the content loader refuses both, so a draft that is copied into the
#     content folder without being written out makes `php artisan lifeos:discovery:validate` (and CI) fail instead of reaching anybody;
#   * one item per merged pull request, with its English title as a starting point; internal work (CI, docs, tests, deploy tooling) is left out and listed on
#     standard error; the type (new / improved / fixed) is only a guess from the title;
#   * features, tours, links and the Arabic and Dutch texts are for the writer.
# Writing, reviewing and approving the real text stays a human job (see docs/DISCOVERY.md).
set -Eeuo pipefail

MARK='⟦DRAFT⟧'
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
die() { echo "release-notes-draft: $*" >&2; exit 2; }

since=""; until_rev="HEAD"; out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) [[ $# -ge 2 ]] || usage; since="$2"; shift 2 ;;
    --until) [[ $# -ge 2 ]] || usage; until_rev="$2"; shift 2 ;;
    --out) [[ $# -ge 2 ]] || usage; out="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done
command -v jq >/dev/null 2>&1 || die "jq is required"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this inside the LifeOS repository"
CONTENT="$ROOT/backend/resources/discovery"

if [[ -z "$since" ]]; then
  newest=""
  for f in "$CONTENT"/releases/*.json; do
    [[ -e "$f" ]] || continue
    d="$(jq -r '.date // empty' "$f")" || continue
    [[ "$d" > "$newest" ]] && newest="$d"
  done
  [[ -n "$newest" ]] || die "there is no earlier release to start from: pass --since <rev|YYYY-MM-DD>"
  since="$newest"
fi

if [[ -n "$out" ]]; then
  parent="$(cd "$(dirname "$out")" 2>/dev/null && pwd -P)" || die "the folder of --out does not exist"
  target="$parent/$(basename "$out")"
  case "$target/" in "$(cd "$CONTENT" 2>/dev/null && pwd -P || echo "$CONTENT")"/*) die "a draft must not be written inside backend/resources/discovery/ (it would stop every release from loading); write it elsewhere and move it there only when it is real text" ;; esac
fi

range=(--first-parent --merges --reverse --format='%H%x1f%s%x1f%b%x1e')
if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  # A date: merges on that day are the previous release's own, so start the day after.
  after="$(date -u -d "$since + 1 day" +%F)" || die "cannot read the date $since"
  log="$(git -C "$ROOT" log "${range[@]}" --since="$after 00:00:00 +0000" "$until_rev")"
else
  git -C "$ROOT" rev-parse --verify --quiet "$since^{commit}" >/dev/null || die "unknown revision: $since"
  log="$(git -C "$ROOT" log "${range[@]}" "$since..$until_rev")"
fi

internal='^(docs?|ci|test|tests|chore|refactor|build|coordination|deploy|release|merge)([ :(/-]|$)|ci/cd|coordination|status update|deploy script|playwright|actionlint|hybrid|flaky|workflow'
re_fixed='^(fix|fixed|fixes|bugfix|hotfix)([ :(/-]|$)'; re_fixed_ar='^(إصلاح|تصحيح)'
re_improved='^(improve|improved|polish|tweak|mobile|a11y)([ :(/-]|$)|contrast|touch target|readable|faster'; re_improved_ar='^تحسين'
items='[]'; skipped=()
while IFS= read -r -d $'\x1e' record; do
  record="${record#$'\n'}"
  [[ -n "$record" ]] || continue
  IFS=$'\x1f' read -r _sha subject body <<<"$record"
  [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+)\ from\ (.+)$ ]] || continue
  number="${BASH_REMATCH[1]}"; branch="${BASH_REMATCH[2]}"
  title="$(printf '%s' "$body" | sed -n '/[^[:space:]]/{p;q}')"
  [[ -n "$title" ]] || title="${branch#*/}"
  lower="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower" =~ $internal ]]; then skipped+=("#$number $title"); continue; fi
  type="new"
  if [[ "$lower" =~ $re_fixed || "$title" =~ $re_fixed_ar ]]; then type="fixed"
  elif [[ "$lower" =~ $re_improved || "$title" =~ $re_improved_ar ]]; then type="improved"; fi
  items="$(jq -c --arg t "$type" --arg title "$title" --arg mark "$MARK" --argjson n "$number" \
    '. + [{type: $t, _pr: $n, title: {en: ($mark + " " + $title), ar: $mark, nl: $mark}, body: {en: ($mark + " Describe what changed for a person using LifeOS."), ar: $mark, nl: $mark}}]' <<<"$items")"
done <<<"$log"

count="$(jq 'length' <<<"$items")"
for s in "${skipped[@]+"${skipped[@]}"}"; do echo "release-notes-draft: skipped (internal): $s" >&2; done
if [[ "$count" -eq 0 ]]; then echo "release-notes-draft: no user-facing pull request merged since $since; nothing to draft" >&2; exit 0; fi

today="$(date -u +%F)"
draft="$(jq -n --arg mark "$MARK" --arg key "$today-draft" --arg date "$today" --argjson items "$items" --arg since "$since" '{
  _draft: ("Delete this key and replace every " + $mark + " with real text in Arabic, Dutch and English. Generated from the pull requests merged since " + $since + "."),
  key: $key, date: $date, revision: 1, importance: "normal", audiences: ["web", "mobile"],
  title: {en: ($mark + " Release title"), ar: $mark, nl: $mark},
  summary: {en: ($mark + " One or two sentences on what people get."), ar: $mark, nl: $mark},
  items: $items }')"
if [[ -n "$out" ]]; then printf '%s\n' "$draft" > "$target"; echo "release-notes-draft: wrote $target ($count item(s))" >&2; else printf '%s\n' "$draft"; fi
