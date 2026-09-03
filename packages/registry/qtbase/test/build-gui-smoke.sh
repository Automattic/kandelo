#!/usr/bin/env bash
#
# Link qt_gui_smoke.cpp against the resolved qtbase and write an
# instrumented wasm32 program to $1.
#
# The link line is written out rather than derived from Qt's CMake
# package because the consumer is a plain SDK compile, not a CMake
# project. Two properties it has to preserve:
#
#   -D__linux__=1 -DQT_LINUXBASE   The same two defines build-qtbase.sh
#                                  configures with. Qt's public headers
#                                  read them: without the first,
#                                  qsystemdetection.h:134 errors out;
#                                  without the second the headers and
#                                  the archives disagree about the futex.
#
#   -lc++ -lc++abi last            The SDK driver places its own -lc++
#                                  before the archives, so libunwind's
#                                  __wasm_lpad_context stays undefined
#                                  unless these come after them.
#
# Plugins precede the modules they extend, and every library follows its
# users: a static link resolves in one pass.

set -euo pipefail

OUT="${1:?usage: build-gui-smoke.sh <out.wasm>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

for tool in wasm32posix-c++ cargo wasm-objdump; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"

# `build-deps path` answers a different cache root than `resolve` writes
# under WASM_POSIX_RESOLUTION_POLICY=source-only-v1, so take the prefix
# from resolve, which prints it and is a no-op once cached.
prefix() {
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet \
        -- build-deps resolve "$1") | tail -1
}

QTBASE="$(prefix qtbase)"
FREETYPE="$(prefix freetype)"
FONTCONFIG="$(prefix fontconfig)"
HARFBUZZ="$(prefix harfbuzz)"
LIBPNG="$(prefix libpng)"
LIBXKBCOMMON="$(prefix libxkbcommon)"
LIBWAYLAND="$(prefix libwayland)"
LIBXML2="$(prefix libxml2)"
LIBFFI="$(prefix libffi)"
LIBICONV="$(prefix libiconv)"
ZLIB="$(prefix zlib)"
LIBCXX="$(prefix libcxx)"

RAW="${OUT%.wasm}.raw.wasm"
rm -f "$OUT" "$RAW"

wasm32posix-c++ \
    -O2 -std=c++17 -fwasm-exceptions \
    -D__linux__=1 -DQT_LINUXBASE \
    -I"$QTBASE/include" \
    -I"$QTBASE/include/QtCore" \
    -I"$QTBASE/include/QtGui" \
    "$SCRIPT_DIR/qt_gui_smoke.cpp" \
    "$QTBASE/plugins/platforms/libqwayland.a" \
    "$QTBASE/plugins/platforms/libqoffscreen.a" \
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
    "${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}/lib/libgbm.a" \
    "${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}/lib/libdrm.a" \
    "$ZLIB/lib/libz.a" \
    "$LIBCXX/lib/libc++.a" \
    "$LIBCXX/lib/libc++abi.a" \
    -o "$RAW"

# The SDK link does not fail on an undefined symbol — it leaves one as a
# host import, and the program traps only if that path ever runs. A
# missing archive therefore reaches the kernel as
# `Unimplemented import: env.<symbol>`. These three are the runtime's own
# surface; anything else here is a library the line forgot.
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

bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$RAW" -o "$OUT"
rm -f "$RAW"

echo "QT_GUI_SMOKE_BUILT $OUT"
