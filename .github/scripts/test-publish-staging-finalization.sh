#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/publish-staging-finalization.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/final/archives" "$TMP_ROOT/release"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

cat >"$TMP_ROOT/state-lock.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"${GH_STUB_ROOT:?}/lock.log"
EOF
chmod +x "$TMP_ROOT/state-lock.sh"

cat >"$TMP_ROOT/download.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
asset=""; sha=""; size=""; output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) shift 2 ;;
    --asset) asset="$2"; shift 2 ;;
    --sha256) sha="$2"; shift 2 ;;
    --size) size="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) exit 2 ;;
  esac
done
source="${GH_STUB_ROOT:?}/release/$asset"
[ -f "$source" ]
[ "$(wc -c <"$source" | tr -d '[:space:]')" = "$size" ]
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$source" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$source" | awk '{print $1}')
fi
[ "$actual" = "$sha" ]
mkdir -p "$(dirname "$output")"
cp "$source" "$output"
EOF
chmod +x "$TMP_ROOT/download.sh"

cat >"$TMP_ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="${GH_STUB_ROOT:?}"
if [ "$1 $2" = "release view" ]; then
  if [ -f "$root/release-created" ]; then
    exit 0
  fi
  echo "release not found (HTTP 404)" >&2
  exit 1
elif [ "$1 $2" = "release create" ]; then
  touch "$root/release-created"
  exit 0
elif [ "$1 $2" = "release upload" ]; then
  source="${@: -1}"
  name="$(basename "$source")"
  cp "$source" "$root/release/$name"
  if [ "${GH_STUB_AMBIGUOUS_ONCE:-0}" = 1 ] &&
     [ ! -f "$root/ambiguous-used" ]; then
    touch "$root/ambiguous-used"
    exit 1
  fi
  exit 0
elif [ "$1" = api ]; then
  query="${*: -1}"
  name="$(printf '%s\n' "$query" | sed -n 's/.*name == "\([^"]*\)".*/\1/p')"
  if [ -n "$name" ]; then
    [ -f "$root/release/$name" ] && printf '17\n'
  fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
EOF
chmod +x "$TMP_ROOT/bin/gh"

ARCHIVE_NAME="zlib-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst"
printf 'verified archive\n' >"$TMP_ROOT/final/archives/$ARCHIVE_NAME"
printf 'abi_version = 39\n' >"$TMP_ROOT/final/index.toml"
ARCHIVE_SHA="$(sha256_file "$TMP_ROOT/final/archives/$ARCHIVE_NAME")"
ARCHIVE_SIZE="$(wc -c <"$TMP_ROOT/final/archives/$ARCHIVE_NAME" | tr -d '[:space:]')"
jq -n \
  --arg name "$ARCHIVE_NAME" \
  --arg sha "$ARCHIVE_SHA" \
  --argjson size "$ARCHIVE_SIZE" \
  '[{name:$name,sha256:$sha,size:$size}]' >"$TMP_ROOT/final/assets.json"

run_publisher() {
  env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_STUB_ROOT="$TMP_ROOT" \
    GH_STUB_AMBIGUOUS_ONCE="${GH_STUB_AMBIGUOUS_ONCE:-0}" \
    GITHUB_REPOSITORY=Automattic/kandelo \
    STATE_LOCK_SCRIPT="$TMP_ROOT/state-lock.sh" \
    DOWNLOAD_SCRIPT="$TMP_ROOT/download.sh" \
    STAGING_PUBLISH_RETRY_SECONDS=0 \
    bash "$SCRIPT" \
      --target-tag pr-1087-staging \
      --target-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --final-dir "$TMP_ROOT/final"
}

GH_STUB_AMBIGUOUS_ONCE=1 run_publisher
cmp "$TMP_ROOT/final/archives/$ARCHIVE_NAME" "$TMP_ROOT/release/$ARCHIVE_NAME"
cmp "$TMP_ROOT/final/index.toml" "$TMP_ROOT/release/index.toml"
[ "$(grep -c '^acquire$' "$TMP_ROOT/lock.log")" = 1 ]
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 1 ]

# An idempotent retry reuses the exact immutable archive and writes the same
# complete index without changing its bytes.
run_publisher
[ "$(grep -c '^acquire$' "$TMP_ROOT/lock.log")" = 2 ]
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 2 ]

printf 'conflicting remote bytes\n' >"$TMP_ROOT/release/$ARCHIVE_NAME"
if run_publisher; then
  echo "publisher accepted conflicting bytes under an immutable archive name" >&2
  exit 1
fi
grep -Fxq 'conflicting remote bytes' "$TMP_ROOT/release/$ARCHIVE_NAME"
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 3 ]

echo "staging finalization publisher tests passed"
