#!/usr/bin/env bash
# Canonical package-system build for today's browser shell. This recipe builds
# a platform-only base, then materializes the exact admitted flat Homebrew
# selection into one self-contained VFS image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=build-tool-path.sh
source "$SCRIPT_DIR/build-tool-path.sh"
# Package recipes remain portable outside the repository, but authoritative
# Kandelo builds enter through Nix. Strip runner paths once here so every
# composer subprocess consumes the same declared Nix-owned tool closure.
kandelo_shell_activate_build_tool_path

OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"

if [ -z "$OUT_DIR" ]; then
    echo "ERROR: shell is a resolver-owned package build; WASM_POSIX_DEP_OUT_DIR is required" >&2
    exit 2
fi
if [ "${WASM_POSIX_DEP_TARGET_ARCH:-}" != "wasm32" ]; then
    echo "ERROR: shell Homebrew closure currently supports only wasm32" >&2
    exit 2
fi

# Public npm inputs, bottles, and the public tap are package inputs, never
# credentialed ambient state. NODE_OPTIONS and NODE_PATH are also excluded:
# otherwise a developer or runner could inject unreviewed JavaScript into the
# locked composer even though the npm installation itself is isolated.
unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
    NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
    NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
    npm_config_userconfig npm_config_globalconfig npm_config_registry

# Fixed locale/time inputs make mkrootfs bytes independent of the invoking
# developer or CI runner.
export SOURCE_DATE_EPOCH=0
export TZ=UTC
export LC_ALL=C
export LANG=C

BUILD_DIR="$OUT_DIR/.homebrew-shell-build"
SOURCE_ROOT="$BUILD_DIR/source"
VFS="$BUILD_DIR/shell.vfs.zst"
PLATFORM_BASE="$BUILD_DIR/platform-base.vfs.zst"
REPORT="$BUILD_DIR/main-shell-report.json"
BOTTLE_CACHE="$BUILD_DIR/bottle-cache"
if [ -e "$BUILD_DIR" ] || [ -L "$BUILD_DIR" ]; then
    echo "ERROR: resolver-owned shell workspace already exists: $BUILD_DIR" >&2
    exit 1
fi
mkdir "$BUILD_DIR"
cleanup() {
    rm -rf -- "$BUILD_DIR"
}
trap cleanup EXIT

# The recipe owns its host-side composer tools just as it owns every other
# source-build input. This must run inside the recipe—not in selected callers—
# because the resolver can fall back after any archive fails validation. The
# preparer copies Git-owned inputs into this resolver-exclusive workspace, so
# npm and the composer never mutate or execute from the shared checkout.
bash "$SCRIPT_DIR/prepare-build-tools.sh" "$SOURCE_ROOT"

# Read the ABI from the authoritative Rust declaration without introducing an
# undeclared text-processing tool into the package recipe.
ABI_VERSION=""
while IFS= read -r line; do
    if [[ "$line" =~ ^pub[[:space:]]+const[[:space:]]+ABI_VERSION:[[:space:]]+u32[[:space:]]*=[[:space:]]*([0-9]+)\;[[:space:]]*$ ]]; then
        if [ -n "$ABI_VERSION" ]; then
            echo "ERROR: crates/shared/src/lib.rs declares ABI_VERSION more than once" >&2
            exit 1
        fi
        ABI_VERSION="${BASH_REMATCH[1]}"
    fi
done <"$SOURCE_ROOT/crates/shared/src/lib.rs"
if [ -z "$ABI_VERSION" ]; then
    echo "ERROR: could not read ABI_VERSION from crates/shared/src/lib.rs" >&2
    exit 1
fi

# WHY: the generic rootfs package currently carries the retired lazy-shell
# lineage. Build the platform-only source tree directly so the admitted flat
# product cannot inherit deferred archives or a second Homebrew authority.
node "$SOURCE_ROOT/tools/mkrootfs/bin/mkrootfs.mjs" build \
    "$SOURCE_ROOT/MANIFEST" "$SOURCE_ROOT/images/rootfs" \
    --repo-root "$SOURCE_ROOT" \
    --sab-size 536870912 \
    --max-size 536870912 \
    --kernel-abi "$ABI_VERSION" \
    -o "$PLATFORM_BASE"
[ -f "$PLATFORM_BASE" ] || {
    echo "ERROR: $PLATFORM_BASE not produced by mkrootfs" >&2
    exit 1
}

mkdir -m 700 "$BOTTLE_CACHE"
"$SOURCE_ROOT/node_modules/.bin/tsx" \
    "$SOURCE_ROOT/images/vfs/scripts/build-homebrew-flat-vfs-image.ts" \
    --selection "$SOURCE_ROOT/homebrew/main-shell-flat-selection.json" \
    --base-image "$PLATFORM_BASE" \
    --bottle-cache "$BOTTLE_CACHE" \
    --shell-config "$SOURCE_ROOT/homebrew/main-shell-default.json" \
    --demo-config "$SOURCE_ROOT/homebrew/main-shell-flat-demo.json" \
    --out "$VFS" --report "$REPORT"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }
[ -f "$REPORT" ] || { echo "ERROR: $REPORT not produced by builder" >&2; exit 1; }
cp "$VFS" "$OUT_DIR/shell.vfs.zst"
