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
  printf '%s\n' "$name" >>"$root/upload.log"
  if [ -f "$root/release/$name" ] &&
     [[ " $* " != *" --clobber "* ]]; then
    echo "asset already exists" >&2
    exit 1
  fi
  cp "$source" "$root/release/$name"
  if [ "${GH_STUB_AMBIGUOUS_ONCE:-0}" = 1 ] &&
     [ ! -f "$root/ambiguous-used" ]; then
    touch "$root/ambiguous-used"
    exit 1
  fi
  exit 0
elif [ "$1" = api ]; then
  endpoint=""
  for argument in "$@"; do
    case "$argument" in
      /repos/*/releases/*) endpoint="$argument" ;;
    esac
  done
  case "$endpoint" in
    /repos/*/releases/tags/*)
      printf '23\n'
      ;;
    /repos/*/releases/23/assets\?per_page=100)
      if [ "${GH_STUB_PARTIAL_ONCE:-0}" = 1 ] &&
         [ ! -f "$root/partial-used" ]; then
        # Simulate gh emitting an incomplete first page before the HTTP stream
        # fails. A retry must replace, never append to, these partial bytes.
        printf '[[{"id":1,"name":"truncated'
        touch "$root/partial-used"
        exit 1
      fi
      first="$root/assets-page-one.ndjson"
      second="$root/assets-page-two.ndjson"
      : >"$first"
      : >"$second"
      # Put 100 unrelated assets on page one. Every real release file is only
      # visible on page two, which catches regressions to embedded/truncated
      # release metadata or a one-page REST query.
      for id in $(seq 1 100); do
        jq -cn \
          --argjson id "$id" \
          --arg name "unrelated-$id.tar.zst" \
          '{id:$id,name:$name}' >>"$first"
      done
      id=1000
      for source in "$root"/release/*; do
        [ -f "$source" ] || continue
        jq -cn \
          --argjson id "$id" \
          --arg name "$(basename "$source")" \
          '{id:$id,name:$name}' >>"$second"
        id=$((id + 1))
      done
      if [ -n "${GH_STUB_DUPLICATE_NAME:-}" ]; then
        jq -cn \
          --argjson id 9000 \
          --arg name "$GH_STUB_DUPLICATE_NAME" \
          '{id:$id,name:$name}' >>"$second"
      fi
      jq -n --slurpfile first "$first" --slurpfile second "$second" \
        '[$first,$second]'
      ;;
    *)
      echo "unexpected gh api endpoint: $endpoint" >&2
      exit 1
      ;;
  esac
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
  local final_dir="${1:-$TMP_ROOT/final}"
  env \
    PATH="$TMP_ROOT/bin:$PATH" \
    GH_STUB_ROOT="$TMP_ROOT" \
    GH_STUB_AMBIGUOUS_ONCE="${GH_STUB_AMBIGUOUS_ONCE:-0}" \
    GH_STUB_PARTIAL_ONCE="${GH_STUB_PARTIAL_ONCE:-0}" \
    GH_STUB_DUPLICATE_NAME="${GH_STUB_DUPLICATE_NAME:-}" \
    GITHUB_REPOSITORY=Automattic/kandelo \
    STATE_LOCK_SCRIPT="$TMP_ROOT/state-lock.sh" \
    DOWNLOAD_SCRIPT="$TMP_ROOT/download.sh" \
    STAGING_PUBLISH_RETRY_SECONDS=0 \
    bash "$SCRIPT" \
      --target-tag pr-1087-staging \
      --target-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      --final-dir "$final_dir"
}

GH_STUB_AMBIGUOUS_ONCE=1 GH_STUB_PARTIAL_ONCE=1 run_publisher
[ -f "$TMP_ROOT/partial-used" ]
cmp "$TMP_ROOT/final/archives/$ARCHIVE_NAME" "$TMP_ROOT/release/$ARCHIVE_NAME"
cmp "$TMP_ROOT/final/index.toml" "$TMP_ROOT/release/index.toml"
[ "$(grep -c '^acquire$' "$TMP_ROOT/lock.log")" = 1 ]
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 1 ]

# An idempotent retry reuses the exact immutable archive and writes the same
# complete index without changing its bytes.
run_publisher
[ "$(grep -c '^acquire$' "$TMP_ROOT/lock.log")" = 2 ]
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 2 ]
[ "$(grep -Fxc "$ARCHIVE_NAME" "$TMP_ROOT/upload.log")" = 1 ]

# Duplicate asset metadata makes a paginated inventory ambiguous. Reject it
# before any immutable upload instead of choosing one matching name.
if GH_STUB_DUPLICATE_NAME="$ARCHIVE_NAME" run_publisher; then
  echo "publisher accepted duplicate release asset names" >&2
  exit 1
fi
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 3 ]
[ "$(grep -Fxc "$ARCHIVE_NAME" "$TMP_ROOT/upload.log")" = 1 ]

printf 'conflicting remote bytes\n' >"$TMP_ROOT/release/$ARCHIVE_NAME"
if run_publisher; then
  echo "publisher accepted conflicting bytes under an immutable archive name" >&2
  exit 1
fi
grep -Fxq 'conflicting remote bytes' "$TMP_ROOT/release/$ARCHIVE_NAME"
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 4 ]

# A first-ABI run in which every package failed still publishes one truthful
# failed-entry index and no archives. Prove that an empty asset plan does not
# make the archive loop or final inventory verification invent an asset.
mkdir -p "$TMP_ROOT/empty-final/archives"
printf 'abi_version = 39\nfailed = true\n' >"$TMP_ROOT/empty-final/index.toml"
printf '[]\n' >"$TMP_ROOT/empty-final/assets.json"
run_publisher "$TMP_ROOT/empty-final"
cmp "$TMP_ROOT/empty-final/index.toml" "$TMP_ROOT/release/index.toml"
[ "$(grep -Fxc "$ARCHIVE_NAME" "$TMP_ROOT/upload.log")" = 1 ]
[ "$(grep -Fxc index.toml "$TMP_ROOT/upload.log")" = 3 ]
[ "$(grep -c '^release$' "$TMP_ROOT/lock.log")" = 5 ]

echo "staging finalization publisher tests passed"
