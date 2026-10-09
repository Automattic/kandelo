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

for tool in wasm32posix-c++ cargo; do
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
LIBDBUS="$(prefix libdbus)"
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
    -nostdinc++ -isystem "$LIBCXX/include/c++/v1" -L"$LIBCXX/lib" \
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
    "$QTBASE/lib/libQt6DBus.a" \
    "$QTBASE/lib/libQt6Core.a" \
    "$QTBASE/lib/libQt6BundledPcre2.a" \
    "$LIBDBUS/lib/libdbus-1.a" \
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

# The link fails on any symbol no archive defines (the SDK leaves only the
# host's declared imports undefined), so a library this line forgets is a
# link error naming the symbol. libc++ comes from the resolved libcxx
# package; the shared worktree sysroot does not carry it.

bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$RAW" -o "$OUT"
rm -f "$RAW"

echo "QT_GUI_SMOKE_BUILT $OUT"
