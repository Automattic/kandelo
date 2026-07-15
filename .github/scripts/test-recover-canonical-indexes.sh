#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/recover-canonical-indexes.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"
REAL_JQ="$(command -v jq)"

cat > "$BIN/jq" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${GH_RECOVERY_MODE:-normal}" = filter-failure ]; then
  for arg in "$@"; do
    if [ "$arg" = '.[] | select(.tag_name | test("^binaries-abi-v[1-9][0-9]{0,9}$"))' ]; then
      exit 86
    fi
  done
fi
exec "${REAL_JQ:?}" "$@"
EOF
chmod +x "$BIN/jq"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = api ] || exit 99
shift
include=false
endpoint=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --include) include=true; shift ;;
    /repos/*) endpoint="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\n' "$endpoint" >> "$GH_RECOVERY_API_LOG"

if [ "${GH_RECOVERY_MODE:-normal}" = uncertain ]; then
  printf 'HTTP/2.0 503 Service Unavailable\n\n{}\n'
  exit 1
fi
endpoint_count=$(grep -Fxc "$endpoint" "$GH_RECOVERY_API_LOG")
if [ "${GH_RECOVERY_MODE:-normal}" = release-drift ] &&
   [ "$endpoint" = '/repos/example/repo/releases?per_page=2&page=1' ] &&
   [ "$endpoint_count" -ge 2 ]
then
  printf '[{"id":6,"tag_name":"binaries-abi-v39","body":"managed"},{"id":2,"tag_name":"binaries-abi-v40","body":"managed"}]\n'
  exit 0
fi
if [ "${GH_RECOVERY_MODE:-normal}" = asset-drift ] &&
   [ "$endpoint" = '/repos/example/repo/releases/1/assets?per_page=2&page=1' ] &&
   [ "$endpoint_count" -ge 2 ]
then
  cat <<'JSON'
[{"id":11,"name":"kandelo-index-state-v1.json","label":"index-head-v1:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","state":"uploaded"},{"id":12,"name":"index.toml","label":null,"state":"uploaded"}]
JSON
  exit 0
fi
if [ "$endpoint" = '/repos/example/repo/releases/tags/binaries-abi-v40' ]
then
  case "${GH_RECOVERY_MODE:-normal}" in
    exact-empty)
      if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
      exit 0
      ;;
    exact-different)
      if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
      printf '{"id":8,"tag_name":"binaries-abi-v39","body":"managed"}\n'
      exit 0
      ;;
    exact-multiple)
      if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
      printf '%s\n' \
        '{"id":2,"tag_name":"binaries-abi-v40","body":"managed"}' \
        '{"id":8,"tag_name":"binaries-abi-v40","body":"managed"}'
      exit 0
      ;;
  esac
fi
if [ "${GH_RECOVERY_MODE:-normal}" = overflow-sweep ] &&
   [ "$endpoint" = '/repos/example/repo/releases?per_page=2&page=3' ]
then
  printf '[{"id":5,"tag_name":"binaries-abi-v37","body":"managed"},{"id":7,"tag_name":"binaries-abi-v4294967296","body":"managed"}]\n'
  exit 0
fi

case "$endpoint" in
  /repos/example/repo/releases\?per_page=2\&page=1)
    cat <<'JSON'
[{"id":1,"tag_name":"binaries-abi-v39","body":"managed"},{"id":2,"tag_name":"binaries-abi-v40","body":"managed"}]
JSON
    ;;
  /repos/example/repo/releases\?per_page=2\&page=2)
    cat <<'JSON'
[{"id":3,"tag_name":"binaries-abi-v38","body":"legacy"},{"id":4,"tag_name":"binaries-abi-v41","body":"<!-- kandelo-index-state-v1:empty -->"}]
JSON
    ;;
  /repos/example/repo/releases\?per_page=2\&page=3)
    cat <<'JSON'
[{"id":5,"tag_name":"binaries-abi-v37","body":"managed"},{"id":6,"tag_name":"binaries-abi-v7-2026-05-09","body":"legacy"}]
JSON
    ;;
  /repos/example/repo/releases\?per_page=2\&page=4) printf '[]\n' ;;
  /repos/example/repo/releases/tags/binaries-abi-v40)
    if [ "$include" = true ]; then printf 'HTTP/2.0 200 OK\n\n'; fi
    printf '{"id":2,"tag_name":"binaries-abi-v40","body":"managed"}\n'
    ;;
  /repos/example/repo/releases/tags/binaries-abi-v42)
    printf 'HTTP/2.0 404 Not Found\n\n{}\n'; exit 1
    ;;
  /repos/example/repo/releases/1/assets\?per_page=2\&page=1)
    cat <<'JSON'
[{"id":11,"name":"kandelo-index-state-v1.json","label":"index-head-v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"uploaded"},{"id":12,"name":"index.toml","label":null,"state":"uploaded"}]
JSON
    ;;
  /repos/example/repo/releases/1/assets\?per_page=2\&page=2)
    printf '[{"id":13,"name":"kandelo-index-transaction-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json","label":null,"state":"uploaded"}]\n'
    ;;
  /repos/example/repo/releases/2/assets\?per_page=2\&page=1)
    cat <<'JSON'
[{"id":21,"name":"kandelo-index-state-v1.json","label":"index-head-v1:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","state":"uploaded"},{"id":22,"name":"kandelo-index-generation-v1-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.toml","label":null,"state":"uploaded"}]
JSON
    ;;
  /repos/example/repo/releases/2/assets\?per_page=2\&page=2) printf '[]\n' ;;
  /repos/example/repo/releases/3/assets\?per_page=2\&page=1)
    printf '[{"id":31,"name":"index.toml","label":null,"state":"uploaded"}]\n'
    ;;
  /repos/example/repo/releases/4/assets\?per_page=2\&page=1) printf '[]\n' ;;
  /repos/example/repo/releases/5/assets\?per_page=2\&page=1)
    cat <<'JSON'
[{"id":51,"name":"kandelo-index-state-v1.json","label":"index-head-v1:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","state":"uploaded"},{"id":52,"name":"index.toml","label":null,"state":"uploaded"}]
JSON
    ;;
  /repos/example/repo/releases/5/assets\?per_page=2\&page=2)
    printf '[{"id":53,"name":"kandelo-index-generation-v1-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd.toml","label":null,"state":"uploaded"}]\n'
    ;;
  *) echo "unexpected gh endpoint: $endpoint" >&2; exit 99 ;;
esac
EOF
chmod +x "$BIN/gh"

LOCK="$TMP_ROOT/state-lock.sh"
cat > "$LOCK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  acquire)
    printf '%s\n' "$2" > "${STATE_LOCK_STATE_FILE:?}"
    printf 'acquire\t%s\n' "$2" >> "$RECOVERY_ACTION_LOG"
    ;;
  release)
    tag=$(cat "${STATE_LOCK_STATE_FILE:?}")
    printf 'release\t%s\n' "$tag" >> "$RECOVERY_ACTION_LOG"
    ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$LOCK"

STATE="$TMP_ROOT/release-index-state.sh"
cat > "$STATE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = recover ] || exit 99
shift
tag=""
abi=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-tag) tag="$2"; shift 2 ;;
    --expected-abi) abi="$2"; shift 2 ;;
    *) shift 2 ;;
  esac
done
printf 'recover\t%s\t%s\n' "$tag" "$abi" >> "$RECOVERY_ACTION_LOG"
if [ "${RECOVERY_FAIL_TAG:-}" = "$tag" ]; then exit 55; fi
EOF
chmod +x "$STATE"

run_recovery() {
  GH_RECOVERY_API_LOG="$TMP_ROOT/api.log" \
  RECOVERY_ACTION_LOG="$TMP_ROOT/actions.log" \
  GITHUB_REPOSITORY=example/repo \
  CANONICAL_RECOVERY_RETRY_DELAY_SECONDS=0 \
  STATE_LOCK_SCRIPT="$LOCK" \
  RELEASE_INDEX_STATE_SCRIPT="$STATE" \
  REAL_JQ="$REAL_JQ" \
  PATH="$BIN:$PATH" \
    bash "$SCRIPT" --max-pages 4 --per-page 2 \
      --max-asset-pages 3 --asset-per-page 2 --max-targets 4 "$@"
}

: > "$TMP_ROOT/api.log"
: > "$TMP_ROOT/actions.log"
run_recovery > "$TMP_ROOT/first.out"
grep -Fq 'binaries-abi-v39 (transaction journal present)' "$TMP_ROOT/first.out"
grep -Fq 'binaries-abi-v40 (committed stable index missing)' "$TMP_ROOT/first.out"
grep -Fq 'binaries-abi-v41 (empty-store marker bootstrap)' "$TMP_ROOT/first.out"
grep -Fq 'skipping unmanaged legacy release binaries-abi-v38' "$TMP_ROOT/first.out"
grep -Fq 'stable managed state for binaries-abi-v37; skipping' "$TMP_ROOT/first.out"
cat > "$TMP_ROOT/expected-actions" <<'EOF'
acquire	binaries-abi-v39
recover	binaries-abi-v39	39
release	binaries-abi-v39
acquire	binaries-abi-v40
recover	binaries-abi-v40	40
release	binaries-abi-v40
acquire	binaries-abi-v41
recover	binaries-abi-v41	41
release	binaries-abi-v41
EOF
cmp "$TMP_ROOT/expected-actions" "$TMP_ROOT/actions.log"
grep -Fq '/releases?per_page=2&page=3' "$TMP_ROOT/api.log"
grep -Fq '/releases/1/assets?per_page=2&page=2' "$TMP_ROOT/api.log"
if grep -Fq '/releases/6/assets?' "$TMP_ROOT/api.log"; then
  echo "dated legacy release assets were queried" >&2
  exit 1
fi

# A zero-candidate scheduled retry repeats the same recovery transaction
# safely; the state helper owns forward recovery and idempotent verification.
run_recovery > "$TMP_ROOT/retry.out"
cat "$TMP_ROOT/expected-actions" "$TMP_ROOT/expected-actions" > "$TMP_ROOT/two-runs"
cmp "$TMP_ROOT/two-runs" "$TMP_ROOT/actions.log"

# A failed release-page producer must abort before the scan can treat its
# missing output as an empty page and take mutation locks.
: > "$TMP_ROOT/api.log"
: > "$TMP_ROOT/actions.log"
if GH_RECOVERY_MODE=filter-failure run_recovery > "$TMP_ROOT/filter-failure.out" 2>&1; then
  echo "release page filter failure was ignored" >&2
  exit 1
fi
grep -Fq 'failed to filter release page 1' "$TMP_ROOT/filter-failure.out"
[ ! -s "$TMP_ROOT/actions.log" ]

# Structurally exact tags still reach the canonical ABI validator. Discovery
# must not silently discard an out-of-range ABI that looks canonical.
: > "$TMP_ROOT/api.log"
: > "$TMP_ROOT/actions.log"
if GH_RECOVERY_MODE=overflow-sweep run_recovery >/dev/null 2>&1; then
  echo "out-of-range canonical release tag was ignored" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
if grep -Fq '/releases/7/assets?' "$TMP_ROOT/api.log"; then
  echo "out-of-range canonical release assets were queried" >&2
  exit 1
fi

# Exact-tag manual recovery bypasses release discovery but keeps asset bounds
# and the same lock protocol.
: > "$TMP_ROOT/actions.log"
run_recovery --target-tag binaries-abi-v40 > "$TMP_ROOT/exact.out"
cat > "$TMP_ROOT/exact-actions" <<'EOF'
acquire	binaries-abi-v40
recover	binaries-abi-v40	40
release	binaries-abi-v40
EOF
cmp "$TMP_ROOT/exact-actions" "$TMP_ROOT/actions.log"

# Exact-target recovery requires one response object with the requested tag.
# Empty, mismatched, or multiple JSON values fail before any asset lookup.
assert_exact_response_rejected() {
  local mode="$1"
  : > "$TMP_ROOT/api.log"
  : > "$TMP_ROOT/actions.log"
  if GH_RECOVERY_MODE="$mode" run_recovery --target-tag binaries-abi-v40 \
    > "$TMP_ROOT/${mode}.out" 2>&1
  then
    echo "$mode exact-target response was accepted" >&2
    exit 1
  fi
  grep -Fq 'exact target binaries-abi-v40 returned malformed or mismatched release identity' \
    "$TMP_ROOT/${mode}.out"
  [ ! -s "$TMP_ROOT/actions.log" ]
  if grep -Eq '/releases/[0-9]+/assets\?' "$TMP_ROOT/api.log"; then
    echo "$mode exact-target response reached asset discovery" >&2
    exit 1
  fi
}

assert_exact_response_rejected exact-empty
assert_exact_response_rejected exact-different
assert_exact_response_rejected exact-multiple

# Helper failure retains the release and still releases the exact tag lock.
: > "$TMP_ROOT/actions.log"
if RECOVERY_FAIL_TAG=binaries-abi-v40 run_recovery --target-tag binaries-abi-v40 >/dev/null 2>&1; then
  echo "recovery helper failure was ignored" >&2
  exit 1
fi
cmp "$TMP_ROOT/exact-actions" "$TMP_ROOT/actions.log"

# Full final pages and API uncertainty fail before any mutation lock is taken.
: > "$TMP_ROOT/actions.log"
if run_recovery --max-pages 1 >/dev/null 2>&1; then
  echo "release pagination truncation was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
if run_recovery --max-asset-pages 1 >/dev/null 2>&1; then
  echo "asset pagination truncation was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
if run_recovery --max-targets 2 >/dev/null 2>&1; then
  echo "actionable target bound was ignored" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
if GH_RECOVERY_MODE=uncertain run_recovery >/dev/null 2>&1; then
  echo "release API uncertainty was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
: > "$TMP_ROOT/api.log"
if GH_RECOVERY_MODE=release-drift run_recovery >/dev/null 2>&1; then
  echo "release pagination drift was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
: > "$TMP_ROOT/api.log"
if GH_RECOVERY_MODE=asset-drift run_recovery >/dev/null 2>&1; then
  echo "asset pagination drift was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
if run_recovery --target-tag binaries-abi-v42 >/dev/null 2>&1; then
  echo "missing exact target was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]
if run_recovery --max-pages >/dev/null 2>&1; then
  echo "missing option value was accepted" >&2
  exit 1
fi
if run_recovery --max-pages 101 >/dev/null 2>&1; then
  echo "oversized page bound was accepted" >&2
  exit 1
fi
if run_recovery --max-targets 501 >/dev/null 2>&1; then
  echo "oversized target bound was accepted" >&2
  exit 1
fi
[ ! -s "$TMP_ROOT/actions.log" ]

echo "canonical index recovery sweep tests passed"
