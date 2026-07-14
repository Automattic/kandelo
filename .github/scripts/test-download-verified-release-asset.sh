#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/download-verified-release-asset.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BIN="$TMP_ROOT/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = release ] && [ "${2:-}" = download ] || exit 99
shift 2
tag="$1"
shift
repository=""; asset=""; dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repository="$2"; shift 2 ;;
    --pattern) asset="$2"; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    --clobber) shift ;;
    *) exit 99 ;;
  esac
done
[ "$tag" = binaries-abi-v39 ]
printf '%s\t%s\t%s\n' "$repository" "$tag" "$asset" >> "$GH_FAKE_ARGS_FILE"
count=0
if [ -f "$GH_FAKE_COUNT_FILE" ]; then
  count="$(cat "$GH_FAKE_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s\n' "$count" > "$GH_FAKE_COUNT_FILE"
if [ "$count" -lt "$GH_FAKE_SUCCEED_ON" ]; then
  printf 'partial archive bytes\n' > "$dir/$asset"
  echo "release not found" >&2
  exit 1
fi
if [ "${GH_FAKE_OMIT_ON_SUCCESS_COUNT:-0}" = "$count" ]; then
  exit 0
fi
cp "$GH_ASSET_FIXTURE" "$dir/$asset"
EOF
chmod +x "$BIN/gh"

fixture="$TMP_ROOT/archive.tar.zst"
printf 'canonical archive bytes\n' > "$fixture"
sha=$(shasum -a 256 "$fixture" | awk '{print $1}')
size=$(wc -c < "$fixture" | tr -d '[:space:]')
asset="libcurl-8.11.1-rev3-abi39-wasm32-d0c9d681.tar.zst"
export GH_FAKE_COUNT_FILE="$TMP_ROOT/count"
export GH_FAKE_ARGS_FILE="$TMP_ROOT/args"
export GH_FAKE_OMIT_ON_SUCCESS_COUNT=0
export GH_FAKE_SUCCEED_ON=1
export RELEASE_DOWNLOAD_RETRY_SECONDS=0

run_download() {
  GH_ASSET_FIXTURE="$fixture" GITHUB_REPOSITORY=example/repo PATH="$BIN:$PATH" \
    bash "$SCRIPT" \
      --tag binaries-abi-v39 \
      --asset "$asset" \
      --sha256 "$1" \
      --size "$2" \
      --output "$3"
}

rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
run_download "$sha" "$size" "$TMP_ROOT/good/$asset" >/dev/null
cmp "$fixture" "$TMP_ROOT/good/$asset"
[ "$(cat "$GH_FAKE_COUNT_FILE")" = 1 ]

rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
export GH_FAKE_SUCCEED_ON=3
export RELEASE_DOWNLOAD_ATTEMPTS=4
run_download "$sha" "$size" "$TMP_ROOT/retried/$asset" \
  >"$TMP_ROOT/retried.out" 2>"$TMP_ROOT/retried.err"
cmp "$fixture" "$TMP_ROOT/retried/$asset"
[ "$(cat "$GH_FAKE_COUNT_FILE")" = 3 ]
[ "$(wc -l < "$GH_FAKE_ARGS_FILE" | tr -d '[:space:]')" = 3 ]
[ "$(sort -u "$GH_FAKE_ARGS_FILE")" = $'example/repo\tbinaries-abi-v39\tlibcurl-8.11.1-rev3-abi39-wasm32-d0c9d681.tar.zst' ]
grep -q 'attempt 2/4' "$TMP_ROOT/retried.err"

rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
export GH_FAKE_OMIT_ON_SUCCESS_COUNT=1
export GH_FAKE_SUCCEED_ON=1
export RELEASE_DOWNLOAD_ATTEMPTS=3
run_download "$sha" "$size" "$TMP_ROOT/missing-after-success/$asset" \
  >"$TMP_ROOT/missing-after-success.out" 2>"$TMP_ROOT/missing-after-success.err"
cmp "$fixture" "$TMP_ROOT/missing-after-success/$asset"
[ "$(cat "$GH_FAKE_COUNT_FILE")" = 2 ]
grep -q 'reported success without a regular' "$TMP_ROOT/missing-after-success.err"
export GH_FAKE_OMIT_ON_SUCCESS_COUNT=0

rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
export GH_FAKE_SUCCEED_ON=99
export RELEASE_DOWNLOAD_ATTEMPTS=3
if run_download "$sha" "$size" "$TMP_ROOT/missing/$asset" \
    >"$TMP_ROOT/missing.out" 2>"$TMP_ROOT/missing.err"
then
  echo "download verifier accepted a permanently unavailable asset" >&2
  exit 1
fi
[ "$(cat "$GH_FAKE_COUNT_FILE")" = 3 ]
[ ! -e "$TMP_ROOT/missing/$asset" ]
grep -q 'failed after 3 attempts' "$TMP_ROOT/missing.err"

bad_sha=$(printf '0%.0s' {1..64})
rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
export GH_FAKE_SUCCEED_ON=1
if run_download "$bad_sha" "$size" "$TMP_ROOT/bad-sha/$asset" \
    >"$TMP_ROOT/bad-sha.out" 2>"$TMP_ROOT/bad-sha.err"
then
  echo "download verifier accepted bytes that disagreed with the snapshot digest" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/bad-sha/$asset" ]
[ "$(cat "$GH_FAKE_COUNT_FILE")" = 1 ]
grep -q 'does not match snapshot' "$TMP_ROOT/bad-sha.err"

rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
if run_download "$sha" "$((size + 1))" "$TMP_ROOT/bad-size/$asset" \
    >"$TMP_ROOT/bad-size.out" 2>"$TMP_ROOT/bad-size.err"
then
  echo "download verifier accepted bytes that disagreed with the snapshot size" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/bad-size/$asset" ]
[ "$(cat "$GH_FAKE_COUNT_FILE")" = 1 ]
grep -q 'does not match snapshot' "$TMP_ROOT/bad-size.err"

rm -f "$GH_FAKE_COUNT_FILE" "$GH_FAKE_ARGS_FILE"
export RELEASE_DOWNLOAD_ATTEMPTS=0
if run_download "$sha" "$size" "$TMP_ROOT/bad-attempts/$asset" \
    >"$TMP_ROOT/bad-attempts.out" 2>"$TMP_ROOT/bad-attempts.err"
then
  echo "download verifier accepted an invalid retry count" >&2
  exit 1
fi
[ ! -e "$GH_FAKE_COUNT_FILE" ]
grep -q 'attempts must be positive' "$TMP_ROOT/bad-attempts.err"

echo "verified release asset download tests passed"
