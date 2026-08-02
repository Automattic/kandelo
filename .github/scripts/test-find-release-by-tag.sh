#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIND_RELEASE="$SCRIPT_DIR/find-release-by-tag.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
DATA="$TMP_ROOT/data"
LOG="$TMP_ROOT/gh.log"
mkdir -p "$BIN" "$DATA"
: >"$LOG"

cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = api ] || exit 99
endpoint="${2:?endpoint required}"
printf '%s\n' "$endpoint" >>"$GH_STUB_LOG"
page="${endpoint##*=}"
if [ -n "${GH_STUB_FAIL_PAGE:-}" ] &&
   [ "$page" = "$GH_STUB_FAIL_PAGE" ]; then
  count=0
  if [ -f "$GH_STUB_FAILURE_COUNT_FILE" ]; then
    count="$(cat "$GH_STUB_FAILURE_COUNT_FILE")"
  fi
  if [ "$count" -lt "${GH_STUB_FAIL_COUNT:-0}" ]; then
    printf '%s\n' "$((count + 1))" >"$GH_STUB_FAILURE_COUNT_FILE"
    exit 1
  fi
fi
cat "$GH_STUB_DATA/page-$page.json"
EOF
chmod +x "$BIN/gh"

release() {
  local id="$1" tag="$2" draft="$3" immutable="$4"
  jq -cn \
    --argjson id "$id" \
    --arg tag "$tag" \
    --argjson draft "$draft" \
    --argjson immutable "$immutable" \
    '{id:$id,tag_name:$tag,draft:$draft,prerelease:true,
      immutable:$immutable}'
}

write_page() {
  local page="$1"
  shift
  printf '%s\n' "$@" | jq -s . >"$DATA/page-$page.json"
}

run_find() {
  GH_STUB_DATA="$DATA" \
    GH_STUB_LOG="$LOG" \
    GH_STUB_FAIL_PAGE="${GH_STUB_FAIL_PAGE:-}" \
    GH_STUB_FAIL_COUNT="${GH_STUB_FAIL_COUNT:-0}" \
    GH_STUB_FAILURE_COUNT_FILE="$TMP_ROOT/failure-count" \
    GITHUB_REPOSITORY=example/repo \
    FIND_RELEASE_MAX_PAGES="${TEST_MAX_PAGES:-4}" \
    FIND_RELEASE_PER_PAGE="${TEST_PER_PAGE:-2}" \
    FIND_RELEASE_RETRY_DELAY_SECONDS=0 \
    PATH="$BIN:$PATH" \
    bash "$FIND_RELEASE" "$@"
}

draft="$(release 7 wanted true false)"
public="$(release 8 wanted false true)"
other_1="$(release 11 other-1 false true)"
other_2="$(release 12 other-2 true false)"

# Drafts are visible only in the authenticated list. The helper returns the
# exact object without ever relying on GitHub's public get-by-tag endpoint.
write_page 1 "$draft"
output="$TMP_ROOT/draft.json"
run_find --tag wanted --output-file "$output"
jq -e '.id == 7 and .tag_name == "wanted" and .draft == true' \
  "$output" >/dev/null
[ "$(wc -l <"$LOG" | tr -d '[:space:]')" = 1 ]

# A full first page does not prove uniqueness. Scan through the short final
# page before returning a public or draft match.
: >"$LOG"
write_page 1 "$other_1" "$other_2"
write_page 2 "$public"
output="$TMP_ROOT/public.json"
run_find --tag wanted --output-file "$output"
jq -e '.id == 8 and .draft == false and .immutable == true' \
  "$output" >/dev/null
grep -Fxq '/repos/example/repo/releases?per_page=2&page=2' "$LOG"

# An absent exact tag is a distinct, fail-closed result and cannot leave stale
# output from an earlier successful call.
write_page 1 "$other_1"
printf 'stale\n' >"$output"
absent_rc=0
run_find --tag wanted --output-file "$output" || absent_rc=$?
[ "$absent_rc" = 44 ]
[ ! -e "$output" ]

# Duplicate exact tags are rejected even when their release IDs differ.
duplicate="$(release 9 wanted true false)"
write_page 1 "$draft" "$other_1"
write_page 2 "$duplicate"
if run_find --tag wanted --output-file "$output" \
    >"$TMP_ROOT/duplicate.out" 2>"$TMP_ROOT/duplicate.err"
then
  echo "find-release-by-tag accepted duplicate exact tags" >&2
  exit 1
fi
grep -Fq 'multiple releases claim tag wanted' "$TMP_ROOT/duplicate.err"
[ ! -e "$output" ]

# Repeated release IDs show that pagination did not produce one coherent
# inventory. Reject them even when only one row carries the requested tag.
repeated_id="$(release 11 wanted true false)"
write_page 1 "$other_1" "$other_2"
write_page 2 "$repeated_id"
if run_find --tag wanted --output-file "$output" \
    >"$TMP_ROOT/repeated.out" 2>"$TMP_ROOT/repeated.err"
then
  echo "find-release-by-tag accepted a repeated release ID" >&2
  exit 1
fi
grep -Fq 'duplicate IDs' "$TMP_ROOT/repeated.err"

# Malformed pages and rows cannot be interpreted as absence.
printf '{}\n' >"$DATA/page-1.json"
if run_find --tag wanted --output-file "$output" \
    >"$TMP_ROOT/page.out" 2>"$TMP_ROOT/page.err"
then
  echo "find-release-by-tag accepted a non-array page" >&2
  exit 1
fi
grep -Fq 'release page 1 is malformed' "$TMP_ROOT/page.err"

printf '[{"id":7,"tag_name":"wanted","draft":true}]\n' \
  >"$DATA/page-1.json"
if run_find --tag wanted --output-file "$output" \
    >"$TMP_ROOT/row.out" 2>"$TMP_ROOT/row.err"
then
  echo "find-release-by-tag accepted a malformed release row" >&2
  exit 1
fi
grep -Fq 'release page 1 is malformed' "$TMP_ROOT/row.err"

# A full final allowed page may hide another matching row. Return uncertainty,
# not a result selected from a truncated inventory.
write_page 1 "$draft" "$other_1"
if TEST_MAX_PAGES=1 run_find --tag wanted --output-file "$output" \
    >"$TMP_ROOT/bound.out" 2>"$TMP_ROOT/bound.err"
then
  echo "find-release-by-tag ignored its pagination bound" >&2
  exit 1
fi
grep -Fq 'release discovery reached its safety bound' "$TMP_ROOT/bound.err"

# Transient list failures are retried without weakening any page checks.
rm -f "$TMP_ROOT/failure-count"
write_page 1 "$draft"
GH_STUB_FAIL_PAGE=1 GH_STUB_FAIL_COUNT=2 \
  run_find --tag wanted --output-file "$output"
[ "$(cat "$TMP_ROOT/failure-count")" = 2 ]
jq -e '.id == 7' "$output" >/dev/null

echo "find release by tag tests passed"
