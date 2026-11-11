#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32

SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
SOURCE_DIR="$KANDELO_PACKAGE_WORK_DIR/sudo-source"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/sudo-build"
PATCH_FILE="$SCRIPT_DIR/patches/wasm-main-envp.patch"

for required in "$PATCH_FILE" "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"; do
    if [ ! -f "$required" ] || [ -L "$required" ]; then
        echo "ERROR: sudo build input must be a regular file: $required" >&2
        exit 2
    fi
done
for tool in make patch; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: sudo requires host tool $tool" >&2
        exit 2
    }
done

kandelo_package_stage_verified_source sudo "$SOURCE_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
    "$KANDELO_PACKAGE_WORK_DIR"
if [ -e "$BUILD_DIR" ] || [ -L "$BUILD_DIR" ]; then
    echo "ERROR: sudo build directory is already occupied: $BUILD_DIR" >&2
    exit 2
fi
mkdir -m 0700 "$BUILD_DIR"
patch -d "$SOURCE_DIR" -p1 < "$PATCH_FILE"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
SDK_ROOT="$(cd "$(dirname "$(command -v wasm32posix-configure)")/.." && pwd)"
if [ ! -f "$SDK_ROOT/config.site" ] || [ -L "$SDK_ROOT/config.site" ]; then
    echo "ERROR: sudo requires the SDK config.site" >&2
    exit 2
fi

# shellcheck source=/dev/null
source "$SCRIPT_DIR/configure.sh"
(
    cd "$BUILD_DIR"
    sudo_configure "$SOURCE_DIR" "$KANDELO_PACKAGE_WORK_DIR" "$SDK_ROOT"
    make -j2
)

while IFS=: read -r relative output; do
    linked="$BUILD_DIR/$relative"
    instrumented="$KANDELO_PACKAGE_WORK_DIR/$output"
    if [ ! -f "$linked" ] || [ -L "$linked" ]; then
        echo "ERROR: sudo expected output is unavailable: $relative" >&2
        exit 1
    fi
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$linked" -o "$instrumented"
done <<'OUTPUTS'
src/sudo:sudo.wasm
plugins/sudoers/visudo:visudo.wasm
plugins/sudoers/cvtsudoers:cvtsudoers.wasm
plugins/sudoers/sudoreplay:sudoreplay.wasm
OUTPUTS

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] &&
   [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for output in sudo visudo cvtsudoers sudoreplay; do
    install_local_binary sudo "$KANDELO_PACKAGE_WORK_DIR/$output.wasm" \
        "$output.wasm"
done
