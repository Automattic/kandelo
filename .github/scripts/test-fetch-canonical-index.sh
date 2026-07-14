#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/fetch-canonical-index.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = api ] || exit 99
shift
include=false
endpoint=""
while [ "$#" -gt 0 ]; do
  case "$1" in --include) include=true; shift ;; /repos/*) endpoint="$1"; shift ;; *) shift ;; esac
done
printf '%s\n' "$endpoint" >> "$GH_FETCH_LOG"
if [[ "$endpoint" == */releases/tags/* ]]; then
  case "${GH_FETCH_MODE:-present}" in
    absent) printf 'HTTP/2.0 404 Not Found\n\n{}\n'; exit 1 ;;
    uncertain) printf 'HTTP/2.0 401 Unauthorized\n\n{}\n'; exit 1 ;;
    present)
      [ "$include" = false ] || printf 'HTTP/2.0 200 OK\n\n'
      printf '{"id":7,"tag_name":"binaries-abi-v39","body":"managed"}\n'
      ;;
  esac
elif [[ "$endpoint" == *'/releases/7/assets?'* ]]; then
  page="${endpoint##*page=}"
  if [ "$page" = 1 ]; then
    printf '[{"name":"index.toml","size":10,"digest":"sha256:%064d","state":"uploaded"},{"name":"foo.tar.zst","size":20,"digest":"sha256:%064d","state":"uploaded"}]\n' 1 2
  else printf '[]\n'; fi
else
  exit 99
fi
EOF
chmod +x "$BIN/gh"

LOCK="$TMP_ROOT/lock.sh"
cat > "$LOCK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$1" "${2:-}" >> "$LOCK_LOG"
EOF
chmod +x "$LOCK"

STATE="$TMP_ROOT/index-state.sh"
cat > "$STATE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${1:-}" >> "$STATE_LOG"
[ "${1:-}" = snapshot ] || exit 99
shift
output=""; head=""
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output="$2"; shift 2 ;; --head-file) head="$2"; shift 2 ;; *) shift ;; esac
done
printf 'abi_version = 39\npackage = "kept"\n' > "$output"
printf '%064d\n' 1 > "$head"
EOF
chmod +x "$STATE"

run_fetch() {
  local mode="$1" dir="$2"
  mkdir -p "$dir"
  GH_FETCH_MODE="$mode" GH_FETCH_LOG="$TMP_ROOT/gh.log" LOCK_LOG="$TMP_ROOT/lock.log" \
    STATE_LOG="$TMP_ROOT/state.log" \
    GITHUB_API_RETRY_DELAY_SECONDS=0 GITHUB_REPOSITORY=example/repo \
    STATE_LOCK_SCRIPT="$LOCK" RELEASE_INDEX_STATE_SCRIPT="$STATE" PATH="$BIN:$PATH" \
    bash "$SCRIPT" --target-tag binaries-abi-v39 --abi 39 \
      --output "$dir/index.toml" --state-file "$dir/state" \
      --asset-names-file "$dir/assets.json" \
      --asset-metadata-file "$dir/asset-metadata.json"
}

: > "$TMP_ROOT/lock.log"
: > "$TMP_ROOT/state.log"
run_fetch absent "$TMP_ROOT/absent" >/dev/null
[ "$(cat "$TMP_ROOT/absent/state")" = absent ]
grep -qx 'abi_version = 39' "$TMP_ROOT/absent/index.toml"
jq -e 'length == 0' "$TMP_ROOT/absent/assets.json" >/dev/null
jq -e 'length == 0' "$TMP_ROOT/absent/asset-metadata.json" >/dev/null
run_fetch absent "$TMP_ROOT/absent-retry" >/dev/null
cmp "$TMP_ROOT/absent/index.toml" "$TMP_ROOT/absent-retry/index.toml"

if run_fetch uncertain "$TMP_ROOT/uncertain" >"$TMP_ROOT/uncertain.out" 2>"$TMP_ROOT/uncertain.err"; then
  echo "authorization failure was mapped to an empty canonical ledger" >&2
  exit 1
fi
[ ! -f "$TMP_ROOT/uncertain/state" ]
grep -q 'without a confirmed 404' "$TMP_ROOT/uncertain.err"

run_fetch present "$TMP_ROOT/present" >/dev/null
[ "$(cat "$TMP_ROOT/present/state")" = present ]
grep -qx 'package = "kept"' "$TMP_ROOT/present/index.toml"
jq -e 'index("foo.tar.zst") != null and index("index.toml") != null' \
  "$TMP_ROOT/present/assets.json" >/dev/null
jq -e '
  length == 2 and
  .[0].name == "foo.tar.zst" and
  .[0].size == 20 and
  .[0].digest == ("sha256:" + ("0" * 63) + "2") and
  .[0].state == "uploaded"
' "$TMP_ROOT/present/asset-metadata.json" >/dev/null
[ "$(grep -c '^snapshot$' "$TMP_ROOT/state.log")" -eq 1 ]
! grep -Eq '^(read|recover)$' "$TMP_ROOT/state.log"

# Every path holds the canonical state lock while absence or an immutable
# snapshot is classified; uncertain API results still release it.
[ "$(grep -c '^acquire binaries-abi-v39$' "$TMP_ROOT/lock.log")" -eq 4 ]
[ "$(grep -c '^release ' "$TMP_ROOT/lock.log")" -eq 4 ]

echo "canonical index fetch tests passed"
