#!/usr/bin/env bash
# Canonical package-system build for today's browser shell. This recipe fetches
# the same immutable closed selection as product CI and composes its declared
# output exclusively from that selection's public bottles.
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
WORK_DIR="$BUILD_DIR/work"
VFS="$BUILD_DIR/shell.vfs.zst"
PREPARED_INPUTS="$BUILD_DIR/prepared-inputs"
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

# WHY: the package must reproduce the exact product path, including candidate
# review before publication. It may review pending image bytes only after the
# Formula selection is sealed; a publishable package uses the strict path.
PRODUCT_STATE="$(python3 \
    "$SOURCE_ROOT/scripts/homebrew-main-shell-product-state.py" \
    --root "$SOURCE_ROOT")"
PRODUCT_REVIEW_ARGS=()
case "$PRODUCT_STATE" in
    candidate) PRODUCT_REVIEW_ARGS=(--review-pending-artifact) ;;
    publishable) ;;
    awaiting-selection)
        echo "ERROR: shell package awaits its immutable bottle selection" >&2
        exit 1
        ;;
    *)
        echo "ERROR: unsupported shell product state: $PRODUCT_STATE" >&2
        exit 1
        ;;
esac

bash "$SOURCE_ROOT/scripts/prepare-homebrew-main-shell-inputs.sh" \
    --output-directory "$PREPARED_INPUTS"
bash "$SOURCE_ROOT/scripts/build-homebrew-main-shell-product.sh" \
    --prepared-inputs "$PREPARED_INPUTS" \
    --work-dir "$WORK_DIR" \
    --report "$REPORT" \
    --bottle-cache "$BOTTLE_CACHE" \
    --out "$VFS" \
    "${PRODUCT_REVIEW_ARGS[@]}"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }
[ -f "$REPORT" ] || { echo "ERROR: $REPORT not produced by builder" >&2; exit 1; }
cp "$VFS" "$OUT_DIR/shell.vfs.zst"
