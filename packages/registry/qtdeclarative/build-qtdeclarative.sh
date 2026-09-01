#!/usr/bin/env bash
#
# Cross-compile Qt 6 QtQml, QtQmlModels and QtQuick for wasm32.
#
# The scenegraph renders through the software adaptation: the kernel's
# GL command stream replays onto WebGL2, which only the browser host
# has, and a renderer one host cannot run would break dual-host parity.
# The software adaptation rasterises on the CPU into the same wl_shm
# pools qtdemo paints through. Consumers select it with
# QT_QUICK_BACKEND=software.
#
# qml-network and qml-debug are on — Quickshell's QsIntercept
# subclasses QQmlNetworkAccessManagerFactory and its launcher calls
# QQmlDebuggingEnabler, and QtQml only compiles either with its
# feature. Both ride the QtNetwork qtbase now builds.
#
# CMAKE_BUILD_WITH_INSTALL_RPATH is on because the module ships target
# apps (tools/qml): installing one otherwise relinks to rewrite the
# RPATH, which ninja refuses for non-ELF binaries, and a static wasm
# executable has no RPATH to rewrite.
#
# CMAKE_CXX_STANDARD_LIBRARIES repeats -lc++ and -lc++abi at the end
# of every executable link line: the SDK driver places its own -lc++
# before the archives, so libunwind's __wasm_lpad_context stays
# undefined for the module's target apps unless they come after them
# (the constraint build-gui-smoke.sh documents for manual links).
#
# CMAKE_DISABLE_FIND_PACKAGE_harfbuzz forces Qt6Gui's recorded
# find_package(WrapSystemHarfbuzz) down its pkg-config branch, which
# PKG_CONFIG_LIBDIR restricts to the resolved prefixes. Config mode
# finds the build machine's harfbuzz — the one dependency whose host
# package ships a CMake config file — and links its .so into the
# target apps.
#
# The target defines match build-qtbase.sh exactly — Qt's public
# headers read __linux__ and QT_LINUXBASE, and a module built with a
# different answer disagrees with libQt6Core.a about the futex.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve qtdeclarative`, env vars are set by
# the resolver: WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256, plus WASM_POSIX_DEP_<DEP>_DIR per depends_on entry:
#     WASM_POSIX_DEP_QTBASE_DIR        WASM_POSIX_DEP_HARFBUZZ_DIR
#     WASM_POSIX_DEP_QTSHADERTOOLS_DIR WASM_POSIX_DEP_LIBPNG_DIR
#     WASM_POSIX_DEP_LIBCXX_DIR        WASM_POSIX_DEP_LIBXKBCOMMON_DIR
#     WASM_POSIX_DEP_ZLIB_DIR          WASM_POSIX_DEP_LIBWAYLAND_DIR
#     WASM_POSIX_DEP_FREETYPE_DIR      WASM_POSIX_DEP_FONTCONFIG_DIR

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/qtdeclarative-src"

QTDECLARATIVE_VERSION="${WASM_POSIX_DEP_VERSION:-6.10.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/qtdeclarative-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.qt.io/archive/qt/6.10/${QTDECLARATIVE_VERSION}/submodules/qtdeclarative-everywhere-src-${QTDECLARATIVE_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/qtdeclarative-build"

for tool in wasm32posix-c++ wasm32posix-cc cmake ninja qmake; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

if [ -z "${QT_HOST_PATH:-}" ]; then
    echo "ERROR: QT_HOST_PATH not set. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

HOST_QT_VERSION="$(qmake -query QT_VERSION)"
if [ "$HOST_QT_VERSION" != "$QTDECLARATIVE_VERSION" ]; then
    echo "ERROR: host Qt $HOST_QT_VERSION cannot cross-build Qt $QTDECLARATIVE_VERSION." >&2
    echo "       Qt requires an exact match. Realign flake.nix's pinned Qt" >&2
    echo "       and this recipe's version together." >&2
    exit 1
fi

QTBASE_PREFIX="${WASM_POSIX_DEP_QTBASE_DIR:?WASM_POSIX_DEP_QTBASE_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
QTSHADERTOOLS_PREFIX="${WASM_POSIX_DEP_QTSHADERTOOLS_DIR:?WASM_POSIX_DEP_QTSHADERTOOLS_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set (must be invoked via cargo xtask build-deps resolve qtdeclarative)}"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot qtdeclarative "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading qtdeclarative $QTDECLARATIVE_VERSION..."
    TARBALL="/tmp/qtdeclarative-${QTDECLARATIVE_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/qv4-stack-bounds-on-wasm.patch"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: qtdeclarative resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

DEP_PREFIXES=(
    "$QTBASE_PREFIX"
    "$QTSHADERTOOLS_PREFIX"
    "$ZLIB_PREFIX"
    "$FREETYPE_PREFIX"
    "$FONTCONFIG_PREFIX"
    "$HARFBUZZ_PREFIX"
    "$LIBPNG_PREFIX"
    "$LIBXKBCOMMON_PREFIX"
    "$LIBWAYLAND_PREFIX"
)

# pkg-config must see only the resolved dependency prefixes (the qtbase
# pattern: PKG_CONFIG_PATH leaves the host search path live).
PKG_CONFIG_LIBDIR="$(IFS=:; printf '%s' "${DEP_PREFIXES[*]/%//lib/pkgconfig}")"
export PKG_CONFIG_LIBDIR

CMAKE_PREFIXES="$(IFS=';'; printf '%s' "${DEP_PREFIXES[*]}")"

TARGET_DEFINES="-D__linux__=1 -DQT_LINUXBASE"

GUEST_PREFIX="/usr/local/qt6"

echo "==> Configuring qtdeclarative for wasm32..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER=wasm32posix-cc \
    -DCMAKE_CXX_COMPILER=wasm32posix-c++ \
    -DCMAKE_AR="$(command -v wasm32posix-ar)" \
    -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
    -DCMAKE_C_FLAGS="$TARGET_DEFINES" \
    -DCMAKE_CXX_FLAGS="$TARGET_DEFINES -fwasm-exceptions" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
    -DCMAKE_CXX_STANDARD_LIBRARIES="-lc++ -lc++abi" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_PREFIX_PATH="$CMAKE_PREFIXES" \
    -DCMAKE_INSTALL_PREFIX="$GUEST_PREFIX" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF \
    -DQT_HOST_PATH="$QT_HOST_PATH" \
    -DQT_BUILD_EXAMPLES=OFF \
    -DQT_BUILD_TESTS=OFF \
    -DCMAKE_DISABLE_FIND_PACKAGE_harfbuzz=ON \
    -DFEATURE_qml_network=ON \
    -DFEATURE_qml_debug=ON

echo "==> Building qtdeclarative..."
cmake --build "$BUILD_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Installing to $INSTALL_DIR..."
cmake --install "$BUILD_DIR" --prefix "$INSTALL_DIR"

for lib in libQt6Qml.a libQt6QmlModels.a libQt6Quick.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

echo "==> qtdeclarative $QTDECLARATIVE_VERSION built for wasm32"
