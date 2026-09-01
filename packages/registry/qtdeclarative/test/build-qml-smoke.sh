#!/usr/bin/env bash
#
# Link qt_qml_smoke.cpp against the resolved qtdeclarative and write an
# instrumented wasm32 program to $1.
#
# The link line extends build-gui-smoke.sh's (see that script for the
# two properties every consumer link preserves: the qtbase target
# defines, and -lc++/-lc++abi last). What this one adds is the static
# QML layout: a QML module ships its plugin archive under qml/ in the
# prefix and its runtime under lib/, the program imports the plugin
# class with Q_IMPORT_QML_PLUGIN, and every plugin archive precedes the
# module libraries it registers into.

set -euo pipefail

OUT="${1:?usage: build-qml-smoke.sh <out.wasm>}"

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

QTDECLARATIVE="$(prefix qtdeclarative)"
QTBASE="$(prefix qtbase)"
FREETYPE="$(prefix freetype)"
FONTCONFIG="$(prefix fontconfig)"
HARFBUZZ="$(prefix harfbuzz)"
LIBPNG="$(prefix libpng)"
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
    -I"$QTDECLARATIVE/include" \
    -I"$QTDECLARATIVE/include/QtQml" \
    -I"$QTDECLARATIVE/include/QtQmlIntegration" \
    -I"$QTDECLARATIVE/include/QtQuick" \
    "$SCRIPT_DIR/qt_qml_smoke.cpp" \
    "$QTDECLARATIVE/qml/QtQuick/Window/libquickwindowplugin.a" \
    "$QTDECLARATIVE/qml/QtQuick/libqtquick2plugin.a" \
    "$QTDECLARATIVE/qml/QtQml/WorkerScript/libworkerscriptplugin.a" \
    "$QTDECLARATIVE/qml/QtQml/Models/libmodelsplugin.a" \
    "$QTDECLARATIVE/qml/QtQml/libqmlplugin.a" \
    "$QTDECLARATIVE/lib/libQt6Quick.a" \
    "$QTDECLARATIVE/lib/libQt6QmlMeta.a" \
    "$QTDECLARATIVE/lib/libQt6QmlWorkerScript.a" \
    "$QTDECLARATIVE/lib/libQt6QmlModels.a" \
    "$QTDECLARATIVE/lib/libQt6Qml.a" \
    "$QTBASE/lib/libQt6Network.a" \
    "$QTBASE/plugins/platforms/libqoffscreen.a" \
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

echo "QT_QML_SMOKE_BUILT $OUT"
