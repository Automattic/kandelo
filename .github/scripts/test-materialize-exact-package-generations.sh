#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/scripts" "$TMP_ROOT/consumer"
cp "$SCRIPT_DIR/materialize-exact-package-generations.sh" \
  "$TMP_ROOT/scripts/materialize-exact-package-generations.sh"

source_sha="0123456789abcdef0123456789abcdef01234567"
wasm32_tag="package-generation-browser-inputs-wasm32-abi-v42-sha256-$(printf 'a%.0s' {1..64})"
wasm64_tag="package-generation-browser-inputs-wasm64-abi-v42-sha256-$(printf 'b%.0s' {1..64})"

cat >"$TMP_ROOT/scripts/materialize-durable-package-generation.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
tag=""
consumer_sha=""
required_source=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --consumer-sha) consumer_sha="$2"; shift 2 ;;
    --required-package-source-sha) required_source="$2"; shift 2 ;;
    --output-dir) output="$2"; shift 2 ;;
    --consumer-root|--authority-xtask|--repository) shift 2 ;;
    *) echo "stub materializer: unexpected flag $1" >&2; exit 2 ;;
  esac
done
[ "$consumer_sha" = "${TEST_SOURCE_SHA:?}" ]
[ "$required_source" = "$consumer_sha" ]
[ ! -e "$output" ]
mkdir -p "$output/release" "$output/resolver"
case "$tag" in
  *-wasm32-*)
    arch=wasm32
    packages=(common only32)
    ;;
  *-wasm64-*)
    arch=wasm64
    packages=(common only64)
    ;;
  *)
    echo "stub materializer: unexpected tag $tag" >&2
    exit 2
    ;;
esac
{
  printf '{"identity":{"expected_ledger":{"abi_version":42,"entries":['
  separator=""
  for package in "${packages[@]}"; do
    printf '%s{"package":"%s","kind":"program","arch":"%s","version":"1","revision":1,"cache_key_sha":"%064d","git_inputs":[]}' \
      "$separator" "$package" "$arch" 0
    separator=,
  done
  printf ']}}}\n'
} >"$output/release/generation.json"
{
  printf 'abi_version = 42\ngenerated_at = "test"\ngenerator = "test"\n'
  for package in "${packages[@]}"; do
    archive="${package}-1-rev1-abi42-${arch}-archive.tar.zst"
    printf '\n[[packages]]\nname = "%s"\nversion = "1"\nrevision = 1\n' "$package"
    printf '\n[packages.binary.%s]\nstatus = "success"\n' "$arch"
    printf 'archive_url = "%s"\narchive_sha256 = "%064d"\ncache_key_sha = "%064d"\n' \
      "$archive" 0 0
    printf '%s\n' "$package $arch" >"$output/resolver/$archive"
  done
} >"$output/resolver/index.toml"
printf '%s %s\n' "$tag" "$required_source" >>"${TEST_CALL_LOG:?}"
EOF
chmod +x "$TMP_ROOT/scripts/materialize-durable-package-generation.sh"

cat >"$TMP_ROOT/authority-xtask" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for name in GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
  HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
  ACTIONS_RUNTIME_TOKEN WASM_POSIX_DEPS_REGISTRY; do
  [ -z "${!name:-}" ] || {
    echo "compose inherited credential $name" >&2
    exit 97
  }
done
[ "$1 $2" = "staging-reuse compose" ]
shift 2
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-index|--overlay-index|--overlay-expected-ledger) shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) echo "stub xtask: unexpected flag $1" >&2; exit 2 ;;
  esac
done
cat >"$output" <<'INDEX'
abi_version = 42
generated_at = "test"
generator = "test"

[[packages]]
name = "common"
version = "1"
revision = 1
[packages.binary.wasm32]
status = "success"
archive_url = "common-1-rev1-abi42-wasm32-archive.tar.zst"
[packages.binary.wasm64]
status = "success"
archive_url = "common-1-rev1-abi42-wasm64-archive.tar.zst"

[[packages]]
name = "only32"
version = "1"
revision = 1
[packages.binary.wasm32]
status = "success"
archive_url = "only32-1-rev1-abi42-wasm32-archive.tar.zst"

[[packages]]
name = "only64"
version = "1"
revision = 1
[packages.binary.wasm64]
status = "success"
archive_url = "only64-1-rev1-abi42-wasm64-archive.tar.zst"
INDEX
EOF
chmod +x "$TMP_ROOT/authority-xtask"

: >"$TMP_ROOT/calls.log"
TEST_SOURCE_SHA="$source_sha" \
TEST_CALL_LOG="$TMP_ROOT/calls.log" \
GH_TOKEN=read-token \
GITHUB_TOKEN=fallback-token \
bash "$TMP_ROOT/scripts/materialize-exact-package-generations.sh" \
  --wasm32-tag "$wasm32_tag" \
  --wasm64-tag "$wasm64_tag" \
  --consumer-root "$TMP_ROOT/consumer" \
  --consumer-sha "$source_sha" \
  --authority-xtask "$TMP_ROOT/authority-xtask" \
  --repository Automattic/kandelo \
  --output-dir "$TMP_ROOT/materialized"

[ "$(find "$TMP_ROOT/materialized/resolver" -maxdepth 1 -type f | wc -l | tr -d '[:space:]')" = 5 ]
[ -f "$TMP_ROOT/materialized/generations/wasm32.json" ]
[ -f "$TMP_ROOT/materialized/generations/wasm64.json" ]
grep -Fxq "file://$TMP_ROOT/materialized/resolver/index.toml" \
  "$TMP_ROOT/materialized/index-url.txt"
[ "$(wc -l <"$TMP_ROOT/calls.log" | tr -d '[:space:]')" = 2 ]
grep -Fx "$wasm32_tag $source_sha" "$TMP_ROOT/calls.log" >/dev/null
grep -Fx "$wasm64_tag $source_sha" "$TMP_ROOT/calls.log" >/dev/null

if TEST_SOURCE_SHA="$source_sha" TEST_CALL_LOG="$TMP_ROOT/calls.log" \
   bash "$TMP_ROOT/scripts/materialize-exact-package-generations.sh" \
     --wasm32-tag "$wasm32_tag" \
     --consumer-root "$TMP_ROOT/consumer" \
     --consumer-sha "$source_sha" \
     --authority-xtask "$TMP_ROOT/authority-xtask" \
     --repository Automattic/kandelo \
     --output-dir "$TMP_ROOT/materialized" >/dev/null 2>&1; then
  echo "exact generation materializer overwrote an existing output" >&2
  exit 1
fi

echo "test-materialize-exact-package-generations.sh: ok"
