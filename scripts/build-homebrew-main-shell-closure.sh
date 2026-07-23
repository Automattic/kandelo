#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAP_ROOT=""
EXPECTED_TAP_SHA=""
WORK_DIR=""
OUT=""
REPORT=""
BOTTLE_CACHE=""
BREWFILE="$REPO_ROOT/homebrew/main-shell.Brewfile"
SHELL_CONFIG="$REPO_ROOT/homebrew/main-shell-default.json"
DEMO_CONFIG="$REPO_ROOT/homebrew/main-shell-demo.json"
MIGRATION_LOCK="$REPO_ROOT/homebrew/main-shell-migration-lock.json"
MATERIALIZATION_POLICY="$REPO_ROOT/homebrew/main-shell-materialization-policy.json"
LAZY_ARTIFACT_LOCK="$REPO_ROOT/homebrew/main-shell-lazy-artifact-lock.json"
LAZY_ARTIFACT_CHECKER="$REPO_ROOT/scripts/verify-homebrew-main-shell-artifact-lock.sh"
BOTTLE_MIRROR_REPOSITORY="kandelo-dev/homebrew-tap-core"
LAZY_SHELL=false
MAX_BYTES="$((512 * 1024 * 1024))"

# The shell image is a content-addressed product artifact. Do not let a Nix
# shell, CI runner, or developer's ambient reproducible-build epoch select
# different inode timestamps for otherwise identical inputs.
export SOURCE_DATE_EPOCH=0
export TZ=UTC
export LC_ALL=C
export LANG=C

usage() {
  cat <<'EOF'
Usage: scripts/build-homebrew-main-shell-closure.sh \
  --tap-root <exact-homebrew-tap-core-checkout> \
  --work-dir <new-exclusive-directory> [options]

Materialize today's browser main-shell package closure exclusively from
successful Homebrew bottle sidecars. The platform-only base contains static
Kandelo rootfs state but no legacy package-registry program fragment.

Options:
  --expected-tap-sha <sha> exact catalog SHA; must match the migration lock
  --work-dir <new-dir>      exclusive caller-owned composition workspace
  --out <image.vfs.zst>     output image
  --report <report.json>    composition evidence
  --bottle-cache <dir>      verified bottle cache
  --migration-lock <json>   reviewed package/catalog lock
  --lazy-artifact-lock <json>
                            exact lazy-image digest and timestamp contract
  --max-bytes <bytes>       VFS capacity (default: 536870912)
  --lazy-shell             embed the policy closure and defer every other bottle
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
    --work-dir)
      WORK_DIR="${2:-}"
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
    --migration-lock)
      MIGRATION_LOCK="${2:-}"
      shift 2
      ;;
    --lazy-artifact-lock)
      LAZY_ARTIFACT_LOCK="${2:-}"
      shift 2
      ;;
    --max-bytes)
      MAX_BYTES="${2:-}"
      shift 2
      ;;
    --lazy-shell)
      LAZY_SHELL=true
      shift
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

if [ -z "$TAP_ROOT" ]; then
  echo "build-homebrew-main-shell-closure: --tap-root is required" >&2
  exit 2
fi
if [ -z "$WORK_DIR" ] || [ "$WORK_DIR" = / ] || [ -e "$WORK_DIR" ] || [ -L "$WORK_DIR" ]; then
  echo "build-homebrew-main-shell-closure: --work-dir must name a new exclusive directory" >&2
  exit 2
fi
mkdir "$WORK_DIR"
OUT="${OUT:-$WORK_DIR/main-shell.vfs.zst}"
REPORT="${REPORT:-$WORK_DIR/main-shell-report.json}"
BOTTLE_CACHE="${BOTTLE_CACHE:-$WORK_DIR/bottle-cache}"
if ! [[ "$MAX_BYTES" =~ ^[1-9][0-9]*$ ]] || [ $((MAX_BYTES % 4096)) -ne 0 ]; then
  echo "build-homebrew-main-shell-closure: --max-bytes must be a positive multiple of 4096" >&2
  exit 2
fi
if [ ! -f "$TAP_ROOT/Kandelo/metadata.json" ] ||
   [ "$(git -C "$TAP_ROOT" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]; then
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
if [ "$LAZY_SHELL" = true ] &&
   { [ ! -f "$MATERIALIZATION_POLICY" ] || [ -L "$MATERIALIZATION_POLICY" ]; }; then
  echo "build-homebrew-main-shell-closure: materialization policy must be a regular non-symlink file" >&2
  exit 2
fi
if [ ! -f "$DEMO_CONFIG" ] || [ -L "$DEMO_CONFIG" ]; then
  echo "build-homebrew-main-shell-closure: demo config must be a regular non-symlink file" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || {
  echo "build-homebrew-main-shell-closure: missing jq; run through scripts/dev-shell.sh" >&2
  exit 2
}
if ! LOCK_CATALOG_SHA="$(jq -er '.catalog.tap_commit' "$MIGRATION_LOCK")"; then
  echo "build-homebrew-main-shell-closure: migration lock must pin one catalog commit" >&2
  exit 2
fi
if ! [[ "$LOCK_CATALOG_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "build-homebrew-main-shell-closure: migration lock catalog commit must be a lowercase 40-character SHA" >&2
  exit 2
fi
if [ -z "$EXPECTED_TAP_SHA" ]; then
  EXPECTED_TAP_SHA="$LOCK_CATALOG_SHA"
elif [ "$EXPECTED_TAP_SHA" != "$LOCK_CATALOG_SHA" ]; then
  echo "build-homebrew-main-shell-closure: --expected-tap-sha must match locked catalog $LOCK_CATALOG_SHA" >&2
  exit 2
fi
if ! [[ "$EXPECTED_TAP_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "build-homebrew-main-shell-closure: --expected-tap-sha must be a lowercase 40-character SHA" >&2
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

if [ "$LAZY_SHELL" = true ]; then
  if [ ! -f "$LAZY_ARTIFACT_CHECKER" ] || [ -L "$LAZY_ARTIFACT_CHECKER" ]; then
    echo "build-homebrew-main-shell-closure: lazy artifact checker must be a regular non-symlink file" >&2
    exit 2
  fi
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$LAZY_ARTIFACT_LOCK" \
    --expected-source-date-epoch "$SOURCE_DATE_EPOCH"
fi

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
DEMO_CONFIG_SHA="$(sha256sum "$DEMO_CONFIG")"
DEMO_CONFIG_SHA="${DEMO_CONFIG_SHA%% *}"
DEMO_CONFIG_BYTES="$(wc -c <"$DEMO_CONFIG" | tr -d '[:space:]')"

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

PLATFORM_BASE="$WORK_DIR/platform-only.vfs"
SELECTION="$WORK_DIR/main-shell-selection.json"
BOTTLE_MIRROR_OUT="$WORK_DIR/bottle-mirror"
mkdir -p "$WORK_DIR" "$BOTTLE_CACHE" "$(dirname "$OUT")" "$(dirname "$REPORT")"

ruby "$REPO_ROOT/scripts/homebrew-brewfile-selection.rb" "$BREWFILE" >"$SELECTION"
jq -e '
  .schema == 1 and
  .kind == "kandelo-static-brewfile-v1" and
  .tap_name == "kandelo-dev/tap-core" and
  (.packages | length > 0)
' "$SELECTION" >/dev/null

EXPECTED_ROOT_COUNT="$(jq -er '.packages | length' "$MIGRATION_LOCK")"
EXPECTED_CLOSURE_COUNT="$(jq -er '.formula_closure | length' "$MIGRATION_LOCK")"
EXPECTED_EMBEDDED_COUNT=0
EXPECTED_DEFERRED_COUNT=0
EXPECTED_MIRROR_FILE_COUNT=0
if [ "$LAZY_SHELL" = true ]; then
  EXPECTED_EMBEDDED_COUNT="$(jq -er '.embedded_package_order | length' \
    "$MATERIALIZATION_POLICY")"
  if [ "$EXPECTED_EMBEDDED_COUNT" -gt "$EXPECTED_CLOSURE_COUNT" ]; then
    echo "build-homebrew-main-shell-closure: materialization policy exceeds the closure" >&2
    exit 1
  fi
  EXPECTED_DEFERRED_COUNT="$((EXPECTED_CLOSURE_COUNT - EXPECTED_EMBEDDED_COUNT))"
  EXPECTED_MIRROR_FILE_COUNT="$((EXPECTED_DEFERRED_COUNT + 1))"
fi

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

MATERIALIZATION_ARGS=()
MATERIALIZATION_JSON=null
VFS_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-vfs-image.ts"
if [ "$LAZY_SHELL" = true ]; then
  VFS_IMAGE_BUILDER="$REPO_ROOT/images/vfs/scripts/build-homebrew-materialized-vfs-image.ts"
  MATERIALIZATION_ARGS=(
    --materialization-policy "$MATERIALIZATION_POLICY"
    --bottle-mirror-repository "$BOTTLE_MIRROR_REPOSITORY"
    --bottle-mirror-out "$BOTTLE_MIRROR_OUT"
  )
  MATERIALIZATION_JSON="$(jq -c . "$MATERIALIZATION_POLICY")"
fi

"$REPO_ROOT/node_modules/.bin/tsx" \
  "$VFS_IMAGE_BUILDER" \
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
  "${MATERIALIZATION_ARGS[@]}" \
  --write-profile \
  --shell-config "$SHELL_CONFIG" \
  --demo-config "$DEMO_CONFIG" \
  --out "$OUT" \
  --report "$REPORT"

if [ ! -f "$OUT" ] || [ -L "$OUT" ] || [ ! -f "$REPORT" ] || [ -L "$REPORT" ]; then
  echo "build-homebrew-main-shell-closure: image builder did not produce regular image and report files" >&2
  exit 1
fi
if [ "$LAZY_SHELL" = true ]; then
  bash "$LAZY_ARTIFACT_CHECKER" \
    --lock "$LAZY_ARTIFACT_LOCK" \
    --expected-source-date-epoch "$SOURCE_DATE_EPOCH" \
    --artifact "$OUT"
fi

jq -e \
  --slurpfile selection "$SELECTION" \
  --slurpfile tap "$TAP_ROOT/Kandelo/metadata.json" \
  --slurpfile lock "$MIGRATION_LOCK" \
  --argjson materialization "$MATERIALIZATION_JSON" \
  --argjson lazy_shell "$LAZY_SHELL" \
  --argjson abi "$ABI_VERSION" \
  --arg catalog "$EXPECTED_TAP_SHA" \
  --arg lock_sha "$LOCK_SHA" \
  --arg mirror_repository "$BOTTLE_MIRROR_REPOSITORY" \
  --argjson lock_bytes "$LOCK_BYTES" \
  --arg demo_config_sha "$DEMO_CONFIG_SHA" \
  --argjson demo_config_bytes "$DEMO_CONFIG_BYTES" \
  --argjson expected_root_count "$EXPECTED_ROOT_COUNT" \
  --argjson expected_closure_count "$EXPECTED_CLOSURE_COUNT" \
  --argjson expected_embedded_count "$EXPECTED_EMBEDDED_COUNT" \
  --argjson expected_deferred_count "$EXPECTED_DEFERRED_COUNT" \
  --argjson max_bytes "$MAX_BYTES" '
  (.bottle_mirror.tag) as $mirror_tag |
  .schema == 1 and
  .selection.kind == "brewfile" and
  .selection.requested_packages == $selection[0].packages and
  (.selection.requested_packages | length) == $expected_root_count and
  (($selection[0].packages - [.packages[].name]) | length == 0) and
  (.packages | length) == $expected_closure_count and
  (([.packages[].full_name] | sort) == ($lock[0].formula_closure | sort)) and
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
  (.catalog.checkout_commit == $lock[0].catalog.tap_commit) and
  (.migration_lock.sha256 == $lock_sha) and
  (.migration_lock.bytes == $lock_bytes) and
  (if $lazy_shell then
    (.materialization.policy == "kandelo-homebrew-vfs-materialization-policy") and
    (.materialization.embedded_package_order ==
      $materialization.embedded_package_order) and
    (.materialization.embedded_tree_count == $expected_embedded_count) and
    (.materialization.deferred_tree_count == $expected_deferred_count) and
    ((.materialization.embedded_package_order +
      .materialization.deferred_package_order | sort) ==
      ($lock[0].formula_closure | sort)) and
    ((.materialization.deferred_package_order | sort) ==
      ($lock[0].formula_closure -
        $materialization.embedded_package_order | sort)) and
    (.materialization.bottle_mirror.repository == $mirror_repository) and
    (.materialization.bottle_mirror.asset_count == $expected_deferred_count) and
    (.bottle_mirror.repository == $mirror_repository) and
    (.bottle_mirror.tag == .materialization.bottle_mirror.tag) and
    (.bottle_mirror.collection_sha256 ==
      .materialization.bottle_mirror.collection_sha256) and
    (.bottle_mirror.plan.asset ==
      "kandelo-homebrew-bottle-mirror-plan.json") and
    (.bottle_mirror.assets | length == $expected_deferred_count) and
    (([.bottle_mirror.assets[].package] | sort) ==
      (.materialization.deferred_package_order | sort)) and
    ([.bottle_mirror.assets[] |
      (.id | startswith("bottle-")) and
      (.asset | test("^kandelo-homebrew-bottle-.*-layer\\.bin$")) and
      (.sha256 | test("^[0-9a-f]{64}$")) and
      (.bytes > 0) and
      (.url == ("https://github.com/" + $mirror_repository +
        "/releases/download/" + $mirror_tag + "/" + .asset))
    ] | all)
  else
    (.materialization == null) and (.bottle_mirror == null)
  end) and
  (.demo_config == {
    path: "/etc/kandelo/demo.json",
    sha256: $demo_config_sha,
    bytes: $demo_config_bytes
  }) and
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
  ([$lock[0].compatibility.aliases[] as $alias |
    $alias.targets[] as $target |
    [.compatibility_links[] | select(
      .path == $target and
      .package == $alias.package and
      .source == $alias.source and
      .ownership == (if $alias.source_kind == "link"
        then "bottle-link-manifest"
        else "bottle-keg"
      end)
    )] | length == 1
  ] | all) and
  ([.compatibility_links[] |
    (.package | startswith("kandelo-dev/tap-core/")) and
    ((.ownership == "bottle-link-manifest" and
      (.target | startswith("/home/linuxbrew/.linuxbrew/bin/"))) or
     (.ownership == "bottle-keg" and
      (.target | startswith("/home/linuxbrew/.linuxbrew/Cellar/"))))
  ] | all) and
  (([.link_conflicts[] | {
      target,
      package: .selected_package,
      reason
    }] | sort_by(.target)) ==
    ([$lock[0].compatibility.link_conflict_owners[] | {
      target,
      package,
      reason
    }] | sort_by(.target))) and
  ([.link_conflicts[] |
    .selected_package as $selected |
    .resolution == "migration-lock" and
    (.owners | length) > 1 and
    (.owners | index($selected)) != null and
    (.skipped_packages == [.owners[] | select(. != $selected)]) and
    (.path == ("/home/linuxbrew/.linuxbrew/" + .target))
  ] | all) and
  (([.runtime_state[] | {
      requires_package,
      path,
      kind,
      mode,
      uid,
      gid,
      reason
    }]) ==
    ([$lock[0].compatibility.runtime_state[] | {
      requires_package,
      path,
      kind,
      mode,
      uid,
      gid,
      reason
    }])) and
  ([.runtime_state[] |
    if .kind == "directory" then
      (has("content_sha256") | not) and (has("content_bytes") | not)
    else
      (.content_sha256 | test("^[0-9a-f]{64}$")) and
      (.content_bytes >= 0)
    end
  ] | all) and
  (.image_capacity.byte_length <= $max_bytes) and
  (.image_capacity.max_byte_length == $max_bytes) and
  (.base_image.kernelAbi == $abi) and
  (.base_image.metadata.kernelAbi == $abi) and
  (.base_image.metadata.homebrew == null)
' "$REPORT" >/dev/null

if [ "$LAZY_SHELL" = true ]; then
  while IFS=$'\t' read -r asset expected_sha expected_bytes; do
    path="$BOTTLE_MIRROR_OUT/$asset"
    if [ ! -f "$path" ] || [ -L "$path" ]; then
      echo "build-homebrew-main-shell-closure: mirror asset is not a regular file: $path" >&2
      exit 1
    fi
    actual_sha="$(sha256sum "$path")"
    actual_sha="${actual_sha%% *}"
    actual_bytes="$(wc -c <"$path" | tr -d '[:space:]')"
    if [ "$actual_sha" != "$expected_sha" ] || [ "$actual_bytes" != "$expected_bytes" ]; then
      echo "build-homebrew-main-shell-closure: mirror asset identity changed: $path" >&2
      exit 1
    fi
  done < <(jq -r '
    ([.bottle_mirror.plan] + .bottle_mirror.assets)[] |
    [.asset, .sha256, (.bytes | tostring)] | @tsv
  ' "$REPORT")

  MIRROR_ENTRY_COUNT="$(find "$BOTTLE_MIRROR_OUT" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')"
  MIRROR_FILE_COUNT="$(find "$BOTTLE_MIRROR_OUT" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d '[:space:]')"
  if [ "$MIRROR_ENTRY_COUNT" != "$EXPECTED_MIRROR_FILE_COUNT" ] ||
     [ "$MIRROR_FILE_COUNT" != "$EXPECTED_MIRROR_FILE_COUNT" ]; then
    echo "build-homebrew-main-shell-closure: mirror output must contain exactly " \
      "$EXPECTED_DEFERRED_COUNT bottles and one plan" >&2
    exit 1
  fi
fi

echo "Homebrew main-shell closure image: $OUT"
echo "Homebrew main-shell closure report: $REPORT"
if [ "$LAZY_SHELL" = true ]; then
  echo "Homebrew main-shell bottle mirror: $BOTTLE_MIRROR_OUT"
fi
