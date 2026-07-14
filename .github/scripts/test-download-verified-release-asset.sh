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
asset=""; dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) shift 2 ;;
    --pattern) asset="$2"; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    --clobber) shift ;;
    *) exit 99 ;;
  esac
done
[ "$tag" = binaries-abi-v39 ]
cp "$GH_ASSET_FIXTURE" "$dir/$asset"
EOF
chmod +x "$BIN/gh"

fixture="$TMP_ROOT/archive.tar.zst"
printf 'canonical archive bytes\n' > "$fixture"
sha=$(shasum -a 256 "$fixture" | awk '{print $1}')
size=$(wc -c < "$fixture" | tr -d '[:space:]')
asset="libcurl-8.11.1-rev3-abi39-wasm32-d0c9d681.tar.zst"

run_download() {
  GH_ASSET_FIXTURE="$fixture" GITHUB_REPOSITORY=example/repo PATH="$BIN:$PATH" \
    bash "$SCRIPT" \
      --tag binaries-abi-v39 \
      --asset "$asset" \
      --sha256 "$1" \
      --size "$2" \
      --output "$3"
}

run_download "$sha" "$size" "$TMP_ROOT/good/$asset" >/dev/null
cmp "$fixture" "$TMP_ROOT/good/$asset"

bad_sha=$(printf '0%.0s' {1..64})
if run_download "$bad_sha" "$size" "$TMP_ROOT/bad-sha/$asset" \
    >"$TMP_ROOT/bad-sha.out" 2>"$TMP_ROOT/bad-sha.err"
then
  echo "download verifier accepted bytes that disagreed with the snapshot digest" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/bad-sha/$asset" ]
grep -q 'does not match snapshot' "$TMP_ROOT/bad-sha.err"

if run_download "$sha" "$((size + 1))" "$TMP_ROOT/bad-size/$asset" \
    >"$TMP_ROOT/bad-size.out" 2>"$TMP_ROOT/bad-size.err"
then
  echo "download verifier accepted bytes that disagreed with the snapshot size" >&2
  exit 1
fi
[ ! -e "$TMP_ROOT/bad-size/$asset" ]
grep -q 'does not match snapshot' "$TMP_ROOT/bad-size.err"

echo "verified release asset download tests passed"
