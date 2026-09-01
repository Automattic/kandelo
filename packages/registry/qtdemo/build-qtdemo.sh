#!/usr/bin/env bash
#
# Link programs/qtdemo/qtdemo.cpp against the resolved qtbase into qtdemo.wasm.
#
# The link line mirrors packages/registry/qtbase/test/build-gui-smoke.sh,
# which documents the two properties it has to preserve:
#
#   -D__linux__=1 -DQT_LINUXBASE   The same two defines build-qtbase.sh
#                                  configures with. Qt's public headers
#                                  read them.
#
#   -lc++ -lc++abi last            The SDK driver places its own -lc++
#                                  before the archives, so libunwind's
#                                  __wasm_lpad_context stays undefined
#                                  unless these come after them.
#
# Plugins precede the modules they extend, and every library follows its
# users: a static link resolves in one pass.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"

SOURCE="$SOURCE_ROOT/programs/qtdemo/qtdemo.cpp"
if [ ! -f "$SOURCE" ] || [ -L "$SOURCE" ]; then
    echo "ERROR: qtdemo source must be a regular file: $SOURCE" >&2
    exit 1
fi

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

QTBASE="${WASM_POSIX_DEP_QTBASE_DIR:?WASM_POSIX_DEP_QTBASE_DIR not set (must be invoked via cargo xtask build-deps resolve qtdemo)}"
FONTCONFIG="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
HARFBUZZ="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
LIBPNG="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
LIBXML2="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set}"
LIBFFI="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
LIBICONV="${WASM_POSIX_DEP_LIBICONV_DIR:?WASM_POSIX_DEP_LIBICONV_DIR not set}"
LIBXKBCOMMON="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set}"
LIBWAYLAND="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
ZLIB="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
LIBCXX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set}"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

for tool in wasm32posix-c++ wasm-objdump; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: $tool not found — run through scripts/dev-shell.sh" >&2
        exit 1
    }
done

echo "==> Building qtdemo (QtGui raster client)..."
RAW="$WORK_DIR/qtdemo.raw.wasm"
wasm32posix-c++ \
    -O2 -std=c++17 -fwasm-exceptions \
    -D__linux__=1 -DQT_LINUXBASE \
    -I"$QTBASE/include" \
    -I"$QTBASE/include/QtCore" \
    -I"$QTBASE/include/QtGui" \
    "$SOURCE" \
    "$QTBASE/plugins/platforms/libqwayland.a" \
    "$QTBASE/plugins/wayland-shell-integration/libxdg-shell.a" \
    "$QTBASE/lib/libQt6WaylandClient.a" \
    "$QTBASE/lib/libQt6Gui.a" \
    "$QTBASE/lib/libQt6Core.a" \
    "$QTBASE/lib/libQt6BundledPcre2.a" \
    "$FONTCONFIG/lib/libfontconfig.a" \
    "$FREETYPE/lib/libfreetype.a" \
    "$HARFBUZZ/lib/libharfbuzz.a" \
    "$LIBPNG/lib/libpng16.a" \
    "$LIBXML2/lib/libxml2.a" \
    "$LIBFFI/lib/libffi.a" \
    "$LIBICONV/lib/libiconv.a" \
    "$LIBXKBCOMMON/lib/libxkbcommon.a" \
    "$LIBWAYLAND/lib/libwayland-client.a" \
    "$LIBWAYLAND/lib/libwayland-cursor.a" \
    "$WASM_POSIX_SYSROOT/lib/libgbm.a" \
    "$WASM_POSIX_SYSROOT/lib/libdrm.a" \
    "$ZLIB/lib/libz.a" \
    "$LIBCXX/lib/libc++.a" \
    "$LIBCXX/lib/libc++abi.a" \
    -o "$RAW"

# The SDK link does not fail on an undefined symbol — it leaves one as a
# host import, and the program traps only if that path ever runs. These
# three are the runtime's own surface; anything else here is a library
# the line forgot.
UNDEFINED="$(
    wasm-objdump -j Import -x "$RAW" |
        grep -o 'env\.[A-Za-z_0-9]*' |
        sort -u |
        grep -v -x -e 'env.memory' -e 'env.__channel_base' -e 'env.__cxa_thread_atexit' ||
        true
)"
if [ -n "$UNDEFINED" ]; then
    echo "ERROR: the link left library symbols undefined:" >&2
    printf '  %s\n' $UNDEFINED >&2
    exit 1
fi
mv "$RAW" "$WORK_DIR/qtdemo.wasm"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary qtdemo "$WORK_DIR/qtdemo.wasm" "qtdemo.wasm"
