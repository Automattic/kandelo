#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEANUP="$SCRIPT_DIR/cleanup-merge-candidates.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

DATA="$TMP_ROOT/data"
BIN="$TMP_ROOT/bin"
API_LOG="$TMP_ROOT/api.log"
DELETE_LOG="$TMP_ROOT/delete.log"
mkdir -p "$DATA" "$BIN"

TAG_OPEN_READY="merge-candidate-abi-v39-pr-1-run-10-attempt-1"
TAG_OPEN_ACTIVATED="merge-candidate-abi-v39-pr-1-run-11-attempt-1"
TAG_ABANDONED="merge-candidate-abi-v39-pr-2-run-20-attempt-1"
TAG_AUTHORITATIVE="merge-candidate-abi-v39-pr-3-run-30-attempt-1"
TAG_SUPERSEDED="merge-candidate-abi-v39-pr-3-run-31-attempt-1"
TAG_UNREADY="merge-candidate-abi-v39-pr-3-run-32-attempt-1"
TAG_ACTIVATED="merge-candidate-abi-v39-pr-3-run-33-attempt-1"
TAG_REJECTED_RECENT="merge-candidate-abi-v39-pr-4-run-40-attempt-1"
TAG_REJECTED_OLD="merge-candidate-abi-v39-pr-5-run-50-attempt-1"
TAG_UNCERTAIN="merge-candidate-abi-v39-pr-6-run-60-attempt-1"

asset() {
  local name="$1"
  local created_at="$2"
  jq -n --arg name "$name" --arg created_at "$created_at" \
    '{name: $name, created_at: $created_at}'
}

make_release() {
  local tag="$1"
  local id="$2"
  local assets="$3"
  jq -n --arg tag "$tag" --argjson id "$id" \
    '{id: $id, tag_name: $tag, prerelease: true}' > "$DATA/release-$id.json"
  jq '.[0:2]' <<<"$assets" > "$DATA/assets-$id-page-1.json"
  jq '.[2:4]' <<<"$assets" > "$DATA/assets-$id-page-2.json"
  jq '.[4:6]' <<<"$assets" > "$DATA/assets-$id-page-3.json"
}

NOW="2026-07-15T00:00:00Z"
RECENT="2026-07-14T00:00:00Z"
OLD="2026-06-01T00:00:00Z"
DEFAULT_CREATED="2026-07-14T00:00:00Z"
READY="$(asset ready.json "$DEFAULT_CREATED")"
CANDIDATE="$(asset candidate.json "$DEFAULT_CREATED")"
ACTIVATED="$(asset activated.json "$DEFAULT_CREATED")"
REJECTED_RECENT="$(asset rejected.json "$RECENT")"
REJECTED_OLD="$(asset rejected.json "$OLD")"

make_release "$TAG_OPEN_READY" 101 "[$READY]"
make_release "$TAG_OPEN_ACTIVATED" 102 "[$READY,$ACTIVATED]"
make_release "$TAG_ABANDONED" 103 "[$READY]"
make_release "$TAG_AUTHORITATIVE" 104 "[$CANDIDATE,$READY]"
make_release "$TAG_SUPERSEDED" 105 "[$READY]"
make_release "$TAG_UNREADY" 106 "[$CANDIDATE]"
make_release "$TAG_ACTIVATED" 107 "[$READY,$ACTIVATED]"
make_release "$TAG_REJECTED_RECENT" 108 "[$READY,$REJECTED_RECENT]"
make_release "$TAG_REJECTED_OLD" 109 "[$READY,$REJECTED_OLD]"
make_release "$TAG_UNCERTAIN" 110 "[$READY]"

jq -s '.' "$DATA"/release-{101,102,103}.json > "$DATA/releases-page-1.json"
jq -s '.' "$DATA"/release-{104,105,106}.json > "$DATA/releases-page-2.json"
jq -s '.' "$DATA"/release-{107,108,109}.json > "$DATA/releases-page-3.json"
jq -s '.' "$DATA"/release-110.json > "$DATA/releases-page-4.json"

make_pr() {
  local pr="$1"
  local state="$2"
  local merged_at="$3"
  local head="$4"
  jq -n \
    --arg state "$state" \
    --arg merged_at "$merged_at" \
    --arg head "$head" \
    '{state: $state, merged_at: (if $merged_at == "" then null else $merged_at end), head: {sha: $head}}' \
    > "$DATA/pr-$pr.json"
}

HEAD_1="1111111111111111111111111111111111111111"
HEAD_2="2222222222222222222222222222222222222222"
HEAD_3="3333333333333333333333333333333333333333"
HEAD_4="4444444444444444444444444444444444444444"
HEAD_5="5555555555555555555555555555555555555555"
HEAD_6="6666666666666666666666666666666666666666"
make_pr 1 open "" "$HEAD_1"
make_pr 2 closed "" "$HEAD_2"
make_pr 3 closed 2026-07-14T03:00:00Z "$HEAD_3"
make_pr 4 closed 2026-07-14T04:00:00Z "$HEAD_4"
make_pr 5 closed 2026-07-14T05:00:00Z "$HEAD_5"
make_pr 6 closed 2026-07-14T06:00:00Z "$HEAD_6"

status() {
  local head="$1"
  local tag="$2"
  jq -n --arg target "https://github.example/example/repo/releases/tag/$tag" \
    '{statuses: [{context: "merge-gate", state: "success", target_url: $target}]}' \
    > "$DATA/status-$head.json"
}
status "$HEAD_3" "$TAG_AUTHORITATIVE"
jq --arg older "https://github.example/example/repo/releases/tag/$TAG_SUPERSEDED" \
  '.statuses += [{context: "merge-gate", state: "success", target_url: $older}]' \
  "$DATA/status-$HEAD_3.json" > "$DATA/status-$HEAD_3.tmp"
mv "$DATA/status-$HEAD_3.tmp" "$DATA/status-$HEAD_3.json"
status "$HEAD_6" "$TAG_UNCERTAIN"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_STUB_API_LOG"

if [ "${1:-}" = api ]; then
  shift
  include=false
  endpoint=""
  while [ "$#" -gt 0 ]; do
    case "$1" in --include) include=true; shift ;; /repos/*) endpoint="$1"; shift ;; *) shift ;; esac
  done
  [ -n "$endpoint" ] || exit 99
  case "$endpoint" in
    /repos/example/repo/releases\?per_page=3\&page=*)
      page="${endpoint##*=}"
      cat "$GH_STUB_DATA/releases-page-$page.json"
      ;;
    /repos/example/repo/releases/*/assets\?per_page=2\&page=*)
      id="${endpoint#/repos/example/repo/releases/}"
      id="${id%%/*}"
      page="${endpoint##*=}"
      cat "$GH_STUB_DATA/assets-$id-page-$page.json"
      ;;
    /repos/example/repo/pulls/*)
      pr="${endpoint##*/}"
      cat "$GH_STUB_DATA/pr-$pr.json"
      ;;
    /repos/example/repo/releases/tags/*)
      tag="${endpoint##*/}"
      if [ "${GH_STUB_MISSING_TAG:-}" = "$tag" ]; then
        [ "$include" = false ] || printf 'HTTP/2.0 404 Not Found\n\n{}\n'
        exit 1
      fi
      file=""
      for candidate in "$GH_STUB_DATA"/release-*.json; do
        if [ "$(jq -r .tag_name "$candidate")" = "$tag" ]; then file="$candidate"; break; fi
      done
      [ -n "$file" ] || exit 1
      [ "$include" = false ] || printf 'HTTP/2.0 200 OK\n\n'
      cat "$file"
      ;;
    *) exit 99 ;;
  esac
  exit 0
fi

if [ "${1:-}" = release ] && [ "${2:-}" = delete ]; then
  printf '%s\n' "${3:?tag required}" >> "$GH_STUB_DELETE_LOG"
  exit 0
fi
exit 99
EOF
chmod +x "$BIN/gh"

STATUS_STUB="$TMP_ROOT/status.sh"
cat > "$STATUS_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
head=""
while [ "$#" -gt 0 ]; do
  case "$1" in --head-sha) head="$2"; shift 2 ;; *) shift ;; esac
done
printf 'status %s\n' "$head" >> "$GH_STUB_API_LOG"
if [ "${STATUS_STUB_FAIL_HEAD:-}" = "$head" ]; then exit 1; fi
jq -r '.statuses[0].target_url // ""' "$GH_STUB_DATA/status-$head.json"
EOF
chmod +x "$STATUS_STUB"

LOCK_STUB="$TMP_ROOT/state-lock.sh"
cat > "$LOCK_STUB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'lock %s %s\n' "$1" "${2:-}" >> "$GH_STUB_API_LOG"
EOF
chmod +x "$LOCK_STUB"

NOW_EPOCH=$(jq -nr --arg timestamp "$NOW" '$timestamp | fromdateiso8601')
run_cleanup() {
  GH_STUB_DATA="$DATA" \
  GH_STUB_API_LOG="$API_LOG" \
  GH_STUB_DELETE_LOG="$DELETE_LOG" \
  GH_STUB_FAIL_ENDPOINT="${GH_STUB_FAIL_ENDPOINT:-}" \
  GH_STUB_FAIL_COUNT="${GH_STUB_FAIL_COUNT:-0}" \
  GH_STUB_FAILURE_COUNT_FILE="$TMP_ROOT/failure-count" \
  GH_STUB_MISSING_TAG="${GH_STUB_MISSING_TAG:-}" \
  STATUS_STUB_FAIL_HEAD="${STATUS_STUB_FAIL_HEAD:-}" \
  GITHUB_REPOSITORY=example/repo \
  GITHUB_SERVER_URL=https://github.example \
  CANDIDATE_CLEANUP_RETRY_DELAY_SECONDS=0 \
  CANDIDATE_CLEANUP_NOW_EPOCH="$NOW_EPOCH" \
  STATUS_SCRIPT="$STATUS_STUB" \
  STATE_LOCK_SCRIPT="$LOCK_STUB" \
  GITHUB_API_RETRY_DELAY_SECONDS=0 \
  PATH="$BIN:$PATH" \
  "$CLEANUP" \
    --max-pages 5 \
    --per-page 3 \
    --max-asset-pages 3 \
    --asset-per-page 2 \
    --rejected-retention-days 14
}

: > "$API_LOG"
: > "$DELETE_LOG"
run_cleanup > "$TMP_ROOT/cleanup.out"
cat > "$TMP_ROOT/expected-deletes" <<EOF
$TAG_ABANDONED
$TAG_SUPERSEDED
$TAG_UNREADY
$TAG_ACTIVATED
$TAG_REJECTED_OLD
EOF
cmp "$TMP_ROOT/expected-deletes" "$DELETE_LOG"
grep -q "retaining $TAG_OPEN_READY; PR #1 is open" "$TMP_ROOT/cleanup.out"
grep -q "retaining $TAG_OPEN_ACTIVATED; PR #1 is open" "$TMP_ROOT/cleanup.out"
grep -q "retaining authoritative recoverable candidate $TAG_AUTHORITATIVE" "$TMP_ROOT/cleanup.out"
grep -q "retaining rejected evidence $TAG_REJECTED_RECENT" "$TMP_ROOT/cleanup.out"
grep -Fq '/repos/example/repo/releases?per_page=3&page=4' "$API_LOG"
grep -Fq '/repos/example/repo/releases/104/assets?per_page=2&page=2' "$API_LOG"

# Exhausted status retries retain the candidate and fail visibly, rather than
# turning uncertainty into deletion.
: > "$DELETE_LOG"
rm -f "$TMP_ROOT/failure-count"
if STATUS_STUB_FAIL_HEAD="$HEAD_6" \
    run_cleanup >"$TMP_ROOT/uncertain.out" 2>"$TMP_ROOT/uncertain.err"
then
  echo "cleanup hid exhausted status API retries" >&2
  exit 1
fi
if grep -Fxq "$TAG_UNCERTAIN" "$DELETE_LOG"; then
  echo "cleanup deleted a candidate with uncertain status state" >&2
  exit 1
fi
grep -q "retaining $TAG_UNCERTAIN; merge-gate state is uncertain" "$TMP_ROOT/uncertain.err"
grep -Fq "status $HEAD_6" "$API_LOG"

# Discovery is only a hint. If another cleanup removes the release before this
# run obtains authority+candidate locks, the fresh 404 is idempotent success.
: > "$DELETE_LOG"
GH_STUB_MISSING_TAG="$TAG_UNCERTAIN" run_cleanup >"$TMP_ROOT/already-gone.out"
grep -q "$TAG_UNCERTAIN was deleted before lock acquisition" "$TMP_ROOT/already-gone.out"
if grep -Fxq "$TAG_UNCERTAIN" "$DELETE_LOG"; then
  echo "cleanup retried deletion after a confirmed concurrent delete" >&2
  exit 1
fi

# Classification and deletion occur only after authority then candidate lock.
authority_line=$(grep -n "lock acquire merge-authority-pr-3" "$API_LOG" | head -1 | cut -d: -f1)
candidate_line=$(grep -n "lock acquire $TAG_SUPERSEDED" "$API_LOG" | head -1 | cut -d: -f1)
release_line=$(grep -n "/releases/tags/$TAG_SUPERSEDED" "$API_LOG" | head -1 | cut -d: -f1)
[ "$authority_line" -lt "$candidate_line" ] && [ "$candidate_line" -lt "$release_line" ]

# A release-page bound is checked before any candidate is deleted.
: > "$DELETE_LOG"
if GH_STUB_DATA="$DATA" \
    GH_STUB_API_LOG="$API_LOG" \
    GH_STUB_DELETE_LOG="$DELETE_LOG" \
    GITHUB_REPOSITORY=example/repo \
    CANDIDATE_CLEANUP_RETRY_DELAY_SECONDS=0 \
    STATUS_SCRIPT="$STATUS_STUB" \
    STATE_LOCK_SCRIPT="$LOCK_STUB" \
    PATH="$BIN:$PATH" \
    "$CLEANUP" --max-pages 1 --per-page 3 --asset-per-page 2 \
    >"$TMP_ROOT/bounded.out" 2>"$TMP_ROOT/bounded.err"
then
  echo "cleanup accepted a partial release scan" >&2
  exit 1
fi
grep -q 'release scan reached its safety bound' "$TMP_ROOT/bounded.err"
[ ! -s "$DELETE_LOG" ]

echo "merge candidate cleanup tests passed"
