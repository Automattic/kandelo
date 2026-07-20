#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAP_ROOT=""
EXPECTED_TAP_SHA=""
OUT="$REPO_ROOT/target/homebrew-main-shell/main-shell.vfs.zst"
REPORT="$REPO_ROOT/target/homebrew-main-shell/main-shell-report.json"
BOTTLE_CACHE="$REPO_ROOT/target/homebrew-main-shell/bottle-cache"
BREWFILE="$REPO_ROOT/homebrew/main-shell.Brewfile"
SHELL_CONFIG="$REPO_ROOT/homebrew/main-shell-default.json"
MIGRATION_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
MAX_BYTES="$((512 * 1024 * 1024))"

usage() {
  cat <<'EOF'
Usage: scripts/build-homebrew-main-shell-closure.sh \
  --tap-root <exact-homebrew-tap-core-checkout> \
  --expected-tap-sha <40-character-sha> [options]

Materialize today's browser main-shell package closure exclusively from
successful Homebrew bottle sidecars. The platform-only base contains static
Kandelo rootfs state but no legacy package-registry program fragment.

Options:
  --out <image.vfs.zst>     output image
  --report <report.json>    composition evidence
  --bottle-cache <dir>      verified bottle cache
  --max-bytes <bytes>       VFS capacity (default: 536870912)
  -h, --help                show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tap-root)
      TAP_ROOT="${2:-}"
      shift 2
      ;;
    --expected-tap-sha)
      EXPECTED_TAP_SHA="${2:-}"
      shift 2
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    --report)
      REPORT="${2:-}"
      shift 2
      ;;
    --bottle-cache)
      BOTTLE_CACHE="${2:-}"
      shift 2
      ;;
    --max-bytes)
      MAX_BYTES="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "build-homebrew-main-shell-closure: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$TAP_ROOT" ] || [ -z "$EXPECTED_TAP_SHA" ]; then
  echo "build-homebrew-main-shell-closure: --tap-root and --expected-tap-sha are required" >&2
  exit 2
fi
if ! [[ "$EXPECTED_TAP_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "build-homebrew-main-shell-closure: --expected-tap-sha must be a lowercase 40-character SHA" >&2
  exit 2
fi
if ! [[ "$MAX_BYTES" =~ ^[1-9][0-9]*$ ]] || [ $((MAX_BYTES % 4096)) -ne 0 ]; then
  echo "build-homebrew-main-shell-closure: --max-bytes must be a positive multiple of 4096" >&2
  exit 2
fi
if [ ! -f "$TAP_ROOT/Kandelo/metadata.json" ] || [ ! -d "$TAP_ROOT/.git" ]; then
  echo "build-homebrew-main-shell-closure: tap root is not a Git checkout with Kandelo metadata" >&2
  exit 2
fi
if [ ! -f "$BREWFILE" ] || [ -L "$BREWFILE" ]; then
  echo "build-homebrew-main-shell-closure: Brewfile must be a regular non-symlink file" >&2
  exit 2
fi
if [ ! -f "$MIGRATION_LOCK" ] || [ -L "$MIGRATION_LOCK" ]; then
  echo "build-homebrew-main-shell-closure: migration lock must be a regular non-symlink file" >&2
  exit 2
fi

ACTUAL_TAP_SHA="$(git -C "$TAP_ROOT" rev-parse HEAD)"
if [ "$ACTUAL_TAP_SHA" != "$EXPECTED_TAP_SHA" ]; then
  echo "build-homebrew-main-shell-closure: tap HEAD $ACTUAL_TAP_SHA does not match expected $EXPECTED_TAP_SHA" >&2
  exit 1
fi
TAP_STATUS="$(git -C "$TAP_ROOT" status --porcelain=v1 --untracked-files=all)"
if [ -n "$TAP_STATUS" ]; then
  echo "build-homebrew-main-shell-closure: exact tap checkout is dirty" >&2
  printf '%s\n' "$TAP_STATUS" >&2
  exit 1
fi

for tool in git jq node ruby sha256sum wc; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "build-homebrew-main-shell-closure: missing $tool; run through scripts/dev-shell.sh" >&2
    exit 2
  }
done

jq -e '
  .tap_repository == "kandelo-dev/homebrew-tap-core" and
  .tap_name == "kandelo-dev/tap-core"
' "$TAP_ROOT/Kandelo/metadata.json" >/dev/null || {
  echo "build-homebrew-main-shell-closure: tap metadata has the wrong repository identity" >&2
  exit 1
}

LOCK_MAX_BYTES="$(jq -er '.consumer.max_vfs_byte_length' "$MIGRATION_LOCK")"
if [ "$MAX_BYTES" != "$LOCK_MAX_BYTES" ]; then
  echo "build-homebrew-main-shell-closure: --max-bytes must match the locked consumer capacity $LOCK_MAX_BYTES" >&2
  exit 2
fi
LOCK_SHA="$(sha256sum "$MIGRATION_LOCK")"
LOCK_SHA="${LOCK_SHA%% *}"
LOCK_BYTES="$(wc -c <"$MIGRATION_LOCK" | tr -d '[:space:]')"

node "$REPO_ROOT/scripts/check-homebrew-main-shell-brewfile.mjs" \
  "$BREWFILE" "$MIGRATION_LOCK" "$TAP_ROOT/Kandelo/metadata.json"

for required in \
  "$REPO_ROOT/node_modules/.bin/tsx" \
  "$REPO_ROOT/tools/mkrootfs/node_modules"; do
  [ -e "$required" ] || {
    echo "build-homebrew-main-shell-closure: missing dependency install: $required" >&2
    exit 2
  }
done

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs")"
if [ -z "$ABI_VERSION" ]; then
  echo "build-homebrew-main-shell-closure: could not read ABI_VERSION" >&2
  exit 1
fi

WORK_DIR="$REPO_ROOT/target/homebrew-main-shell"
PLATFORM_BASE="$WORK_DIR/platform-only.vfs"
SELECTION="$WORK_DIR/main-shell-selection.json"
mkdir -p "$WORK_DIR" "$BOTTLE_CACHE" "$(dirname "$OUT")" "$(dirname "$REPORT")"

ruby "$REPO_ROOT/scripts/homebrew-brewfile-selection.rb" "$BREWFILE" >"$SELECTION"
jq -e '
  .schema == 1 and
  .kind == "kandelo-static-brewfile-v1" and
  .tap_name == "kandelo-dev/tap-core" and
  (.packages | length > 0)
' "$SELECTION" >/dev/null

# Deliberately omit images/rootfs/PACKAGES.toml's generated manifest fragment.
# This base owns static platform state only, so a successful strict result
# cannot silently retain legacy package-registry program artifacts.
node "$REPO_ROOT/tools/mkrootfs/bin/mkrootfs.mjs" build \
  "$REPO_ROOT/MANIFEST" "$REPO_ROOT/images/rootfs" \
  --repo-root "$REPO_ROOT" \
  --sab-size "$MAX_BYTES" \
  --max-size "$MAX_BYTES" \
  --kernel-abi "$ABI_VERSION" \
  -o "$PLATFORM_BASE"

"$REPO_ROOT/node_modules/.bin/tsx" \
  "$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts" \
  --metadata "$TAP_ROOT/Kandelo/metadata.json" \
  --tap-root "$TAP_ROOT" \
  --brewfile "$BREWFILE" \
  --arch wasm32 \
  --runtime node \
  --base-image "$PLATFORM_BASE" \
  --max-bytes "$MAX_BYTES" \
  --bottle-cache "$BOTTLE_CACHE" \
  --no-fallback \
  --catalog-commit "$EXPECTED_TAP_SHA" \
  --migration-lock "$MIGRATION_LOCK" \
  --write-profile \
  --shell-config "$SHELL_CONFIG" \
  --out "$OUT" \
  --report "$REPORT"

jq -e \
  --slurpfile selection "$SELECTION" \
  --slurpfile tap "$TAP_ROOT/Kandelo/metadata.json" \
  --argjson abi "$ABI_VERSION" \
  --arg catalog "$EXPECTED_TAP_SHA" \
  --arg lock_sha "$LOCK_SHA" \
  --argjson lock_bytes "$LOCK_BYTES" \
  --argjson max_bytes "$MAX_BYTES" '
  .schema == 1 and
  .selection.kind == "brewfile" and
  .selection.requested_packages == $selection[0].packages and
  (($selection[0].packages - [.packages[].name]) | length == 0) and
  (.metadata.tap_repository == $tap[0].tap_repository) and
  (.metadata.tap_name == $tap[0].tap_name) and
  (.metadata.tap_commit == $tap[0].tap_commit) and
  (.metadata.kandelo_repository == $tap[0].kandelo_repository) and
  (.metadata.kandelo_commit == $tap[0].kandelo_commit) and
  (.metadata.kandelo_abi == $abi) and
  (.metadata.kandelo_abi == $tap[0].kandelo_abi) and
  (.metadata.release_tag == $tap[0].release_tag) and
  (.catalog.tap_repository == $tap[0].tap_repository) and
  (.catalog.tap_name == $tap[0].tap_name) and
  (.catalog.checkout_commit == $catalog) and
  (.migration_lock.sha256 == $lock_sha) and
  (.migration_lock.bytes == $lock_bytes) and
  ([.packages[] |
    .arch == "wasm32" and
    .tap_repository == $tap[0].tap_repository and
    .tap_name == $tap[0].tap_name and
    .tap_commit == .built_from.tap_commit and
    .built_from.tap_repository == $tap[0].tap_repository and
    .built_from.kandelo_repository == $tap[0].kandelo_repository and
    (.built_from.tap_commit | test("^[0-9a-f]{40}$")) and
    (.built_from.kandelo_commit | test("^[0-9a-f]{40}$")) and
    (.built_from.formula_sha256 | test("^[0-9a-f]{64}$"))
  ] | all) and
  ([.packages[].source_status] | all(. == "success")) and
  ([.packages[].metadata_status] | all(. == "success")) and
  (.default_shell.path == "/home/linuxbrew/.linuxbrew/bin/bash") and
  (["/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/sh", "/usr/bin/env",
    "/usr/local/bin/fbdoom", "/usr/local/bin/modeset"] -
    [.compatibility_links[].path] | length == 0) and
  ([.compatibility_links[] |
    .ownership == "bottle-link-manifest" and
    (.package | startswith("kandelo-dev/tap-core/")) and
    (.target | startswith("/home/linuxbrew/.linuxbrew/bin/"))
  ] | all) and
  (.image_capacity.byte_length <= $max_bytes) and
  (.image_capacity.max_byte_length == $max_bytes) and
  (.base_image.kernelAbi == $abi) and
  (.base_image.metadata.kernelAbi == $abi) and
  (.base_image.metadata.homebrew == null)
' "$REPORT" >/dev/null

"$REPO_ROOT/node_modules/.bin/tsx" \
  "$REPO_ROOT/scripts/homebrew-main-shell-node-smoke.ts" \
  --image "$OUT"

echo "Homebrew main-shell closure image: $OUT"
echo "Homebrew main-shell closure report: $REPORT"
