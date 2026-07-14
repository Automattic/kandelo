#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RECONCILE="$SCRIPT_DIR/reconcile-merge-candidates.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

DATA="$TMP_ROOT/data"
BIN="$TMP_ROOT/bin"
LOG="$TMP_ROOT/gh.log"
mkdir -p "$DATA" "$BIN"
: > "$LOG"

HISTORY="$TMP_ROOT/history"
git init --quiet -b main "$HISTORY"
git -C "$HISTORY" config user.name test
git -C "$HISTORY" config user.email test@example.invalid
printf 'base\n' > "$HISTORY/order"
git -C "$HISTORY" add order
git -C "$HISTORY" commit --quiet -m base

# Keep more than one pipe buffer of first-parent history behind every candidate
# commit. This catches `git rev-list | grep -q` under `pipefail`: grep exits at
# the first match while git is still writing and git's SIGPIPE is mistaken for
# "not an ancestor".
history_parent=$(git -C "$HISTORY" rev-parse HEAD)
history_tree=$(git -C "$HISTORY" rev-parse 'HEAD^{tree}')
for n in $(seq 1 2048); do
  history_parent=$(printf 'padding-%04d\n' "$n" | \
    git -C "$HISTORY" commit-tree "$history_tree" -p "$history_parent")
done
git -C "$HISTORY" update-ref refs/heads/main "$history_parent"

history_commit() {
  local label="$1"
  printf '%s\n' "$label" >> "$HISTORY/order"
  git -C "$HISTORY" add order
  GIT_AUTHOR_DATE=2026-07-14T02:00:00Z GIT_COMMITTER_DATE=2026-07-14T02:00:00Z \
    git -C "$HISTORY" commit --quiet -m "$label"
  git -C "$HISTORY" rev-parse HEAD
}
MERGE_7=$(history_commit pr-7-older)
MERGE_6=$(history_commit pr-6-middle)
MERGE_1=$(history_commit pr-1-newer)

TAG_READY="merge-candidate-abi-v39-pr-1-run-10-attempt-1"
TAG_UNREADY="merge-candidate-abi-v39-pr-2-run-20-attempt-1"
TAG_ACTIVATED="merge-candidate-abi-v39-pr-3-run-30-attempt-1"
TAG_OPEN="merge-candidate-abi-v39-pr-4-run-40-attempt-1"
TAG_ABANDONED="merge-candidate-abi-v39-pr-5-run-50-attempt-1"
TAG_NONAUTHORITATIVE="merge-candidate-abi-v39-pr-6-run-60-attempt-1"
TAG_READY_EARLIER="merge-candidate-abi-v39-pr-7-run-70-attempt-1"
TAG_REJECTED="merge-candidate-abi-v39-pr-8-run-80-attempt-1"

make_release() {
  local tag="$1"
  local assets_json="$2"
  local release_id="$3"
  jq -n --arg tag "$tag" --argjson assets "$assets_json" --argjson release_id "$release_id" \
    '{id: $release_id, tag_name: $tag, prerelease: true, assets: $assets}' \
    > "$DATA/release-$tag.json"
  printf '%s\n' "$assets_json" > "$DATA/assets-$release_id-page-1.json"
  printf '[]\n' > "$DATA/assets-$release_id-page-2.json"
}

make_pr() {
  local pr="$1"
  local state="$2"
  local merged_at="$3"
  local head_sha="$4"
  local merge_sha="${5:-}"
  if [ -n "$merged_at" ]; then
    jq -n --arg state "$state" --arg merged_at "$merged_at" --arg head_sha "$head_sha" \
      --arg merge_sha "$merge_sha" \
      '{state: $state, merged_at: $merged_at, head: {sha: $head_sha},
        merge_commit_sha: $merge_sha, base: {ref: "main"}}' \
      > "$DATA/pr-$pr.json"
  else
    jq -n --arg state "$state" --arg head_sha "$head_sha" \
      '{state: $state, merged_at: null, head: {sha: $head_sha},
        merge_commit_sha: null, base: {ref: "main"}}' \
      > "$DATA/pr-$pr.json"
  fi
}

make_status() {
  local head_sha="$1"
  local target_url="$2"
  jq -n --arg target_url "$target_url" \
    '{statuses: [{context: "merge-gate", state: "success", target_url: $target_url}]}' \
    > "$DATA/status-$head_sha.json"
}

make_release "$TAG_READY" '[{"name":"candidate.json"},{"name":"ready.json"}]' 101
make_release "$TAG_UNREADY" '[{"name":"candidate.json"}]' 102
make_release "$TAG_ACTIVATED" '[{"name":"ready.json"},{"name":"activated.json"}]' 103
make_release "$TAG_OPEN" '[{"name":"ready.json"}]' 104
make_release "$TAG_ABANDONED" '[{"name":"ready.json"}]' 105
make_release "$TAG_NONAUTHORITATIVE" '[{"name":"ready.json"}]' 106
make_release "$TAG_READY_EARLIER" '[{"name":"ready.json"}]' 107
make_release "$TAG_REJECTED" '[{"name":"ready.json"},{"name":"rejected.json"}]' 108

HEAD_1="1111111111111111111111111111111111111111"
HEAD_2="2222222222222222222222222222222222222222"
HEAD_3="3333333333333333333333333333333333333333"
HEAD_4="4444444444444444444444444444444444444444"
HEAD_5="5555555555555555555555555555555555555555"
HEAD_6="6666666666666666666666666666666666666666"
HEAD_7="7777777777777777777777777777777777777777"

make_pr 1 closed 2026-07-14T02:00:00Z "$HEAD_1" "$MERGE_1"
make_pr 2 open "" "$HEAD_2"
make_pr 3 closed 2026-07-14T02:00:00Z "$HEAD_3" "$MERGE_7"
make_pr 4 open "" "$HEAD_4"
make_pr 5 closed "" "$HEAD_5"
make_pr 6 closed 2026-07-14T02:00:00Z "$HEAD_6" "$MERGE_6"
make_pr 7 closed 2026-07-14T02:00:00Z "$HEAD_7" "$MERGE_7"

BASE_URL="https://github.example/example/repo/releases/tag"
make_status "$HEAD_1" "$BASE_URL/$TAG_READY"
make_status "$HEAD_6" "$BASE_URL/some-other-candidate"
make_status "$HEAD_7" "$BASE_URL/$TAG_READY_EARLIER"

jq -s '.' \
  "$DATA/release-$TAG_READY.json" \
  "$DATA/release-$TAG_UNREADY.json" \
  > "$DATA/releases-page-1.json"
jq -s '.' \
  "$DATA/release-$TAG_ACTIVATED.json" \
  "$DATA/release-$TAG_OPEN.json" \
  > "$DATA/releases-page-2.json"
jq -s '.' \
  "$DATA/release-$TAG_ABANDONED.json" \
  "$DATA/release-$TAG_NONAUTHORITATIVE.json" \
  > "$DATA/releases-page-3.json"
jq -s '.' \
  "$DATA/release-$TAG_READY_EARLIER.json" \
  "$DATA/release-$TAG_REJECTED.json" \
  > "$DATA/releases-page-4.json"
printf '[]\n' > "$DATA/releases-page-5.json"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[ "${1:-}" = api ] || exit 99
endpoint="${2:?endpoint required}"
printf '%s\n' "$endpoint" >> "$GH_STUB_LOG"

if [ -n "${GH_STUB_FAIL_ENDPOINT:-}" ] && [ "$endpoint" = "$GH_STUB_FAIL_ENDPOINT" ]; then
  count=0
  if [ -f "$GH_STUB_FAILURE_COUNT_FILE" ]; then
    count=$(cat "$GH_STUB_FAILURE_COUNT_FILE")
  fi
  if [ "$count" -lt "${GH_STUB_FAIL_COUNT:-0}" ]; then
    printf '%s\n' "$((count + 1))" > "$GH_STUB_FAILURE_COUNT_FILE"
    exit 1
  fi
fi

case "$endpoint" in
  /repos/example/repo/releases\?per_page=2\&page=*)
    page="${endpoint##*=}"
    cat "$GH_STUB_DATA/releases-page-$page.json"
    ;;
  /repos/example/repo/releases/tags/*)
    tag="${endpoint##*/}"
    cat "$GH_STUB_DATA/release-$tag.json"
    ;;
  /repos/example/repo/releases/*/assets\?per_page=2\&page=*)
    release_id="${endpoint#/repos/example/repo/releases/}"
    release_id="${release_id%%/*}"
    page="${endpoint##*=}"
    cat "$GH_STUB_DATA/assets-$release_id-page-$page.json"
    ;;
  /repos/example/repo/pulls/*)
    pr="${endpoint##*/}"
    cat "$GH_STUB_DATA/pr-$pr.json"
    ;;
  *) exit 99 ;;
esac
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
for attempt in 1 2 3 4; do
  printf 'status %s\n' "$head" >> "$GH_STUB_LOG"
  if [ "${STATUS_STUB_FAIL_HEAD:-}" != "$head" ]; then break; fi
  count=0
  [ ! -f "$GH_STUB_FAILURE_COUNT_FILE" ] || count=$(cat "$GH_STUB_FAILURE_COUNT_FILE")
  if [ "$count" -ge "${GH_STUB_FAIL_COUNT:-0}" ]; then break; fi
  printf '%s\n' $((count + 1)) > "$GH_STUB_FAILURE_COUNT_FILE"
  [ "$attempt" -lt 4 ] || exit 1
done
jq -r '.statuses[0].target_url // ""' "$GH_STUB_DATA/status-$head.json"
EOF
chmod +x "$STATUS_STUB"

run_reconcile() {
  (cd "$HISTORY" && GH_STUB_DATA="$DATA" \
  GH_STUB_LOG="$LOG" \
  GH_STUB_FAIL_ENDPOINT="${GH_STUB_FAIL_ENDPOINT:-}" \
  GH_STUB_FAIL_COUNT="${GH_STUB_FAIL_COUNT:-0}" \
  GH_STUB_FAILURE_COUNT_FILE="$TMP_ROOT/failure-count" \
  STATUS_STUB_FAIL_HEAD="${STATUS_STUB_FAIL_HEAD:-}" \
  GITHUB_REPOSITORY=example/repo \
  GITHUB_SERVER_URL=https://github.example \
  GITHUB_DEFAULT_BRANCH=main \
  RECONCILE_RETRY_DELAY_SECONDS=0 \
  STATUS_SCRIPT="$STATUS_STUB" \
  PATH="$BIN:$PATH" \
  "$RECONCILE" --target-ref HEAD --target-branch main "$@")
}

# The scheduled sweep follows bounded pagination, retries transient API
# failures, ignores unready/activated/open/abandoned/non-authoritative
# candidates, and prefers the newest merged package state.
PLAN="$TMP_ROOT/plan.tsv"
STATUS_STUB_FAIL_HEAD="$HEAD_7" GH_STUB_FAIL_COUNT=2 \
  run_reconcile --plan-file "$PLAN" --max-pages 5 --per-page 2 --asset-per-page 2 >/dev/null
cat > "$TMP_ROOT/expected-plan.tsv" <<EOF
2026-07-14T02:00:00Z	1	$TAG_READY
2026-07-14T02:00:00Z	7	$TAG_READY_EARLIER
EOF
cmp "$TMP_ROOT/expected-plan.tsv" "$PLAN"
[ "$(grep -Fc "status $HEAD_7" "$LOG")" -eq 3 ]
grep -Fxq '/repos/example/repo/releases?per_page=2&page=4' "$LOG"
grep -Fxq '/repos/example/repo/releases?per_page=2&page=5' "$LOG"
grep -Fxq '/repos/example/repo/releases/101/assets?per_page=2&page=2' "$LOG"
if grep -Fq "status $HEAD_4" "$LOG" || grep -Fq "status $HEAD_5" "$LOG"
then
  echo "open or abandoned candidate reached merge-gate selection" >&2
  exit 1
fi
if grep -Fq '/repos/example/repo/pulls/8' "$LOG"; then
  echo "terminally rejected candidate reached PR reconciliation" >&2
  exit 1
fi

# A scheduled run activates a bounded batch. Candidates beyond the cap remain
# discoverable by later schedules after activated receipts remove prior work.
run_reconcile \
  --plan-file "$PLAN" \
  --max-pages 5 \
  --per-page 2 \
  --asset-per-page 2 \
  --max-candidates 1 \
  >"$TMP_ROOT/capped.out" \
  2>"$TMP_ROOT/capped.err"
printf '2026-07-14T02:00:00Z\t1\t%s\n' "$TAG_READY" > "$TMP_ROOT/capped-plan.tsv"
cmp "$TMP_ROOT/capped-plan.tsv" "$PLAN"
grep -q 'limiting this run to 1 of 2 candidates' "$TMP_ROOT/capped.err"

# A closed-event/manual PR target resolves the authoritative candidate from
# the latest merge-gate status without depending on a release sweep.
: > "$LOG"
rm -f "$TMP_ROOT/failure-count"
run_reconcile --plan-file "$PLAN" --pr-number 1 --max-pages 1 --per-page 2 --asset-per-page 2 >/dev/null
printf '2026-07-14T02:00:00Z\t1\t%s\n' "$TAG_READY" > "$TMP_ROOT/target-plan.tsv"
cmp "$TMP_ROOT/target-plan.tsv" "$PLAN"
if grep -Fq 'releases?per_page=' "$LOG"; then
  echo "targeted PR reconciliation performed an unnecessary release sweep" >&2
  exit 1
fi

# GitHub fields written into the TSV plan are schema-checked; a malformed
# timestamp cannot inject an extra candidate row or reorder activation.
cp "$DATA/pr-1.json" "$TMP_ROOT/pr-1.good.json"
jq '.merged_at = "2026-07-14T02:00:00Z\n8\tmerge-candidate-abi-v39-pr-8-run-1-attempt-1"' \
  "$TMP_ROOT/pr-1.good.json" > "$DATA/pr-1.json"
if run_reconcile \
    --plan-file "$PLAN" \
    --candidate-tag "$TAG_READY" \
    --asset-per-page 2 \
    >"$TMP_ROOT/injected.out" \
    2>"$TMP_ROOT/injected.err"
then
  echo "malformed merged_at reached the activation plan" >&2
  exit 1
fi
grep -q 'PR #1 response is malformed' "$TMP_ROOT/injected.err"
[ ! -s "$PLAN" ]
mv "$TMP_ROOT/pr-1.good.json" "$DATA/pr-1.json"

# An explicitly requested candidate must still be the candidate selected by
# the successful merge gate; manual dispatch cannot bypass identity binding.
if run_reconcile \
    --plan-file "$PLAN" \
    --pr-number 6 \
    --candidate-tag "$TAG_NONAUTHORITATIVE" \
    --asset-per-page 2 \
    >"$TMP_ROOT/non-authoritative.out" \
    2>"$TMP_ROOT/non-authoritative.err"
then
  echo "non-authoritative candidate was accepted" >&2
  exit 1
fi
grep -q 'does not select' "$TMP_ROOT/non-authoritative.err"
[ ! -s "$PLAN" ]

# A full sweep that fills its final allowed page fails before returning a
# partial plan. Operators can recover an older candidate by exact manual tag.
if run_reconcile \
    --plan-file "$PLAN" \
    --max-pages 1 \
    --per-page 2 \
    --asset-per-page 2 \
    >"$TMP_ROOT/bounded.out" \
    2>"$TMP_ROOT/bounded.err"
then
  echo "bounded release scan silently returned a partial result" >&2
  exit 1
fi
grep -q 'safety bound' "$TMP_ROOT/bounded.err"
[ ! -s "$PLAN" ]

echo "merge candidate reconciliation tests passed"
