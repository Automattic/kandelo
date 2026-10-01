#!/usr/bin/env bash
#
# Cross-compile Qt 6 QtShaderTools for wasm32.
#
# qtdeclarative refuses to configure without this module: QtQuick's
# scenegraph materials are compiled to .qsb at build time by the host
# qsb (QT_HOST_PATH), and this library carries the runtime that loads
# them. The bundled glslang and SPIRV-Cross compile as plain C++.
#
# The target defines match build-qtbase.sh exactly — Qt's public
# headers read __linux__ and QT_LINUXBASE, and a module built with a
# different answer disagrees with libQt6Core.a about the futex.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve qtshadertools`, env vars are set by
# the resolver: WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256, plus WASM_POSIX_DEP_<DEP>_DIR per depends_on entry:
#     WASM_POSIX_DEP_QTBASE_DIR        WASM_POSIX_DEP_HARFBUZZ_DIR
#     WASM_POSIX_DEP_LIBCXX_DIR        WASM_POSIX_DEP_LIBPNG_DIR
#     WASM_POSIX_DEP_ZLIB_DIR          WASM_POSIX_DEP_LIBXKBCOMMON_DIR
#     WASM_POSIX_DEP_FREETYPE_DIR      WASM_POSIX_DEP_LIBWAYLAND_DIR
#     WASM_POSIX_DEP_FONTCONFIG_DIR    WASM_POSIX_DEP_LIBDBUS_DIR
#
# libQt6ShaderTools links Qt::Gui, and the Qt6Gui CMake package loads
# only when every third-party library qtbase was configured against
# resolves too — so this recipe carries qtbase's full dependency set
# even though ShaderTools itself touches none of them. That set now
# includes libdbus: Qt6Gui depends on Qt6DBus, whose config finds
# dbus-1 through pkg-config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/qtshadertools-src"

QTSHADERTOOLS_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/qtshadertools-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/qtshadertools-build"

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
if [ "$HOST_QT_VERSION" != "$QTSHADERTOOLS_VERSION" ]; then
    echo "ERROR: host Qt $HOST_QT_VERSION cannot cross-build Qt $QTSHADERTOOLS_VERSION." >&2
    echo "       Qt requires an exact match. Realign flake.nix's pinned Qt" >&2
    echo "       and this recipe's version together." >&2
    exit 1
fi

QTBASE_PREFIX="${WASM_POSIX_DEP_QTBASE_DIR:?WASM_POSIX_DEP_QTBASE_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"
LIBDBUS_PREFIX="${WASM_POSIX_DEP_LIBDBUS_DIR:?WASM_POSIX_DEP_LIBDBUS_DIR not set (must be invoked via cargo xtask build-deps resolve qtshadertools)}"

SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot qtshadertools "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified qtshadertools $QTSHADERTOOLS_VERSION source..."
    kandelo_package_stage_verified_source qtshadertools "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: qtshadertools resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

DEP_PREFIXES=(
    "$QTBASE_PREFIX"
    "$ZLIB_PREFIX"
    "$FREETYPE_PREFIX"
    "$FONTCONFIG_PREFIX"
    "$HARFBUZZ_PREFIX"
    "$LIBPNG_PREFIX"
    "$LIBXKBCOMMON_PREFIX"
    "$LIBWAYLAND_PREFIX"
    "$LIBDBUS_PREFIX"
)

# pkg-config must see only the resolved dependency prefixes (the qtbase
# pattern: PKG_CONFIG_PATH leaves the host search path live).
PKG_CONFIG_LIBDIR="$(IFS=:; printf '%s' "${DEP_PREFIXES[*]/%//lib/pkgconfig}")"
export PKG_CONFIG_LIBDIR

CMAKE_PREFIXES="$(IFS=';'; printf '%s' "${DEP_PREFIXES[*]}")"

TARGET_DEFINES="-D__linux__=1 -DQT_LINUXBASE"

GUEST_PREFIX="/usr/local/qt6"

echo "==> Configuring qtshadertools for wasm32..."
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
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_PREFIX_PATH="$CMAKE_PREFIXES" \
    -DCMAKE_INSTALL_PREFIX="$GUEST_PREFIX" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF \
    -DQT_HOST_PATH="$QT_HOST_PATH" \
    -DQT_BUILD_EXAMPLES=OFF \
    -DQT_BUILD_TESTS=OFF

echo "==> Building qtshadertools..."
cmake --build "$BUILD_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Installing to $INSTALL_DIR..."
cmake --install "$BUILD_DIR" --prefix "$INSTALL_DIR"

if [ ! -f "$INSTALL_DIR/lib/libQt6ShaderTools.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libQt6ShaderTools.a" >&2
    exit 1
fi

echo "==> qtshadertools $QTSHADERTOOLS_VERSION built for wasm32"
