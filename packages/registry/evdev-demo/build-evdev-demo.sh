#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
EVDEV_DEMO_SOURCE="$SOURCE_ROOT/programs/evdev_demo.c"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
OUT_BIN="$WORK_DIR/evdev_demo.wasm"

if [ ! -f "$EVDEV_DEMO_SOURCE" ] || [ -L "$EVDEV_DEMO_SOURCE" ]; then
    echo "ERROR: evdev_demo source must be a regular file: $EVDEV_DEMO_SOURCE" >&2
    exit 1
fi

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

if [ ! -f "$WASM_POSIX_SYSROOT/include/linux/input.h" ]; then
    echo "ERROR: the vendored evdev headers are missing from the sysroot." >&2
    echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
    exit 1
fi

echo "==> Building evdev_demo..."
wasm32posix-cc \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -Wno-unused-parameter \
    -D_DEFAULT_SOURCE \
    "$EVDEV_DEMO_SOURCE" \
    -o "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary evdev-demo "$OUT_BIN" evdev_demo.wasm
