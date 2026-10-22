#!/usr/bin/env bash
# Cross-compile attr's getfattr and setfattr for Kandelo with the SDK. They
# use the ordinary <sys/xattr.h> syscalls, so they work on any filesystem that
# stores user.* attributes (today, the Kandelo exchange filesystem) and report
# ENOTSUP elsewhere, as on Linux.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/attr-src"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

rm -rf "$SRC"
echo "==> Staging pinned attr source..."
kandelo_package_stage_verified_source attr "$SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"

cd "$SRC"
echo "==> Configuring attr..."
wasm32posix-configure --enable-static --disable-shared --disable-nls 2>&1 | tail -20

# The tools call libc's <sys/xattr.h> functions and attr's small libmisc
# helpers. libattr itself is not built: its syscalls.c only re-exports the
# libc calls under ELF symbol versions (`.symver ...@ATTR_1.0`) for old
# dynamically linked binaries, and Wasm has no ELF symbol versioning.
echo "==> Building libmisc, getfattr and setfattr..."
make libmisc.la 2>&1 | tail -10
for tool in getfattr setfattr; do
    wasm32posix-cc -O2 -DHAVE_CONFIG_H -I"$SRC" -I"$SRC/include" \
        "$SRC/tools/$tool.c" "$SRC"/.libs/libmisc.a \
        -o "$WORK_DIR/$tool.wasm"
done

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary attr "$WORK_DIR/getfattr.wasm" getfattr.wasm
install_local_binary attr "$WORK_DIR/setfattr.wasm" setfattr.wasm
