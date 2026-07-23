#!/usr/bin/env bash
# Canonical package-system build for today's browser shell. The resolver
# provisions the exact public Homebrew tap commit declared in build.toml; this
# script composes the declared output exclusively from that tap's bottles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
HOMEBREW_TAP_ROOT="${WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR:-}"
HOMEBREW_TAP_SHA="${WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT:-}"
HOMEBREW_BOOTSTRAP_DIR="${WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR:-}"

if [ -z "$OUT_DIR" ]; then
    echo "ERROR: shell is a resolver-owned package build; WASM_POSIX_DEP_OUT_DIR is required" >&2
    exit 2
fi
if [ -z "$HOMEBREW_TAP_ROOT" ] || [ -z "$HOMEBREW_TAP_SHA" ]; then
    echo "ERROR: shell requires build.toml git input homebrew_tap_core (DIR and COMMIT)" >&2
    exit 2
fi
if [ -z "$HOMEBREW_BOOTSTRAP_DIR" ]; then
    echo "ERROR: shell requires its declared homebrew-bootstrap dependency" >&2
    exit 2
fi
if [ "${WASM_POSIX_DEP_TARGET_ARCH:-}" != "wasm32" ]; then
    echo "ERROR: shell Homebrew closure currently supports only wasm32" >&2
    exit 2
fi

# Public bottles and the public tap are package inputs, never credentialed
# ambient state. Fixed locale/time inputs also make mkrootfs bytes independent
# of the invoking developer or CI runner.
unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN
export SOURCE_DATE_EPOCH=0
export TZ=UTC
export LC_ALL=C
export LANG=C

BUILD_DIR="$OUT_DIR/.homebrew-shell-build"
WORK_DIR="$BUILD_DIR/work"
VFS="$BUILD_DIR/shell.vfs.zst"
HOMEBREW_BOOTSTRAP="$HOMEBREW_BOOTSTRAP_DIR/homebrew-bootstrap.zip"
HOMEBREW_BREW_ENV="$HOMEBREW_BOOTSTRAP_DIR/homebrew-brew.env"
REPORT="$BUILD_DIR/main-shell-report.json"
BOTTLE_CACHE="$BUILD_DIR/bottle-cache"
if [ -e "$BUILD_DIR" ] || [ -L "$BUILD_DIR" ]; then
    echo "ERROR: resolver-owned shell workspace already exists: $BUILD_DIR" >&2
    exit 1
fi
mkdir "$BUILD_DIR"
if [ ! -f "$HOMEBREW_BOOTSTRAP" ] || [ -L "$HOMEBREW_BOOTSTRAP" ]; then
    echo "ERROR: declared homebrew-bootstrap output is not a regular file: $HOMEBREW_BOOTSTRAP" >&2
    exit 2
fi
if [ ! -f "$HOMEBREW_BREW_ENV" ] || [ -L "$HOMEBREW_BREW_ENV" ]; then
    echo "ERROR: declared Homebrew environment output is not a regular file: $HOMEBREW_BREW_ENV" >&2
    exit 2
fi
cleanup() {
    rm -rf -- "$BUILD_DIR"
}
trap cleanup EXIT

# The checkout is sealed read-only by the resolver. Disable Git's optional
# index refresh while the strict composer independently verifies exact HEAD,
# cleanliness, and the migration-lock commit.
GIT_OPTIONAL_LOCKS=0 \
bash "$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh" \
    --lazy-shell \
    --tap-root "$HOMEBREW_TAP_ROOT" \
    --expected-tap-sha "$HOMEBREW_TAP_SHA" \
    --work-dir "$WORK_DIR" \
    --report "$REPORT" \
    --bottle-cache "$BOTTLE_CACHE" \
    --package-tree-spec "$REPO_ROOT/homebrew/main-shell-brew-package-tree.json" \
    --package-tree-archive "$HOMEBREW_BOOTSTRAP" \
    --homebrew-bootstrap-env "$HOMEBREW_BREW_ENV" \
    --out "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }
[ -f "$REPORT" ] || { echo "ERROR: $REPORT not produced by builder" >&2; exit 1; }
cp "$VFS" "$OUT_DIR/shell.vfs.zst"
