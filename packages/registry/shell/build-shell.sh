#!/usr/bin/env bash
# Canonical package-system build for today's browser shell. The resolver
# provisions the exact public Homebrew tap commit declared in build.toml; this
# script composes the declared output exclusively from that tap's bottles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
HOMEBREW_TAP_ROOT="${WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR:-}"
HOMEBREW_TAP_SHA="${WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT:-}"

if [ -z "$OUT_DIR" ]; then
    echo "ERROR: shell is a resolver-owned package build; WASM_POSIX_DEP_OUT_DIR is required" >&2
    exit 2
fi
if [ -z "$HOMEBREW_TAP_ROOT" ] || [ -z "$HOMEBREW_TAP_SHA" ]; then
    echo "ERROR: shell requires build.toml git input homebrew_tap_core (DIR and COMMIT)" >&2
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

# The checkout is sealed read-only by the resolver. Disable Git's optional
# index refresh while the strict composer independently verifies exact HEAD,
# cleanliness, and the migration-lock commit.
GIT_OPTIONAL_LOCKS=0 \
bash "$SOURCE_ROOT/scripts/build-homebrew-main-shell-closure.sh" \
    --lazy-shell \
    --tap-root "$HOMEBREW_TAP_ROOT" \
    --expected-tap-sha "$HOMEBREW_TAP_SHA" \
    --work-dir "$WORK_DIR" \
    --report "$REPORT" \
    --bottle-cache "$BOTTLE_CACHE" \
    --out "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }
[ -f "$REPORT" ] || { echo "ERROR: $REPORT not produced by builder" >&2; exit 1; }
cp "$VFS" "$OUT_DIR/shell.vfs.zst"
