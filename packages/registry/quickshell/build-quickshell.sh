#!/usr/bin/env bash
#
# Cross-compile Quickshell 0.3.1 (quickshell.wasm) for wasm32.
#
# The CMake cross setup mirrors build-qtdeclarative.sh — the target
# defines match qtbase, CMAKE_CXX_STANDARD_LIBRARIES closes the static
# link at the end of the executable line (libffi for libwayland's
# closure marshalling, libxml2+libiconv+libcharset for fontconfig,
# the sysroot gbm for the dmabuf buffer module, -lc++/-lc++abi last —
# the waybar link closure is the model), and the harfbuzz config-mode
# leak is cut with CMAKE_DISABLE_FIND_PACKAGE.
#
# Feature selection: WAYLAND stays on with WLR_LAYERSHELL (Omarchy's
# bar is a layer-shell surface); everything else is off because its
# dependency does not exist here — see package.toml. The wayland glue
# needs the host wayland-scanner and Qt6::qtwaylandscanner, both from
# the dev shell (nix/qtwaylandscanner/ shims the latter when nixpkgs
# does not expose it).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve quickshell`, env vars are set by the
# resolver: WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256, plus WASM_POSIX_DEP_<DEP>_DIR per depends_on entry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/quickshell-src"

QUICKSHELL_VERSION="${WASM_POSIX_DEP_VERSION:-0.3.1}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/quickshell-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/quickshell-mirror/quickshell/archive/refs/tags/v${QUICKSHELL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/quickshell-build"

for tool in wasm32posix-c++ wasm32posix-cc cmake ninja qmake wayland-scanner; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

if [ -z "${QT_HOST_PATH:-}" ]; then
    echo "ERROR: QT_HOST_PATH not set. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

QTBASE_PREFIX="${WASM_POSIX_DEP_QTBASE_DIR:?WASM_POSIX_DEP_QTBASE_DIR not set (must be invoked via cargo xtask build-deps resolve quickshell)}"
QTDECLARATIVE_PREFIX="${WASM_POSIX_DEP_QTDECLARATIVE_DIR:?WASM_POSIX_DEP_QTDECLARATIVE_DIR not set}"
QTSHADERTOOLS_PREFIX="${WASM_POSIX_DEP_QTSHADERTOOLS_DIR:?WASM_POSIX_DEP_QTSHADERTOOLS_DIR not set}"
CLI11_PREFIX="${WASM_POSIX_DEP_CLI11_DIR:?WASM_POSIX_DEP_CLI11_DIR not set}"
LIBDRM_PREFIX="${WASM_POSIX_DEP_LIBDRM_DIR:?WASM_POSIX_DEP_LIBDRM_DIR not set}"
WAYLAND_PROTOCOLS_PREFIX="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
LIBICONV_PREFIX="${WASM_POSIX_DEP_LIBICONV_DIR:?WASM_POSIX_DEP_LIBICONV_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set}"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot quickshell "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading quickshell $QUICKSHELL_VERSION..."
    TARBALL="/tmp/quickshell-${QUICKSHELL_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/no-wl-proxy-interpose-on-wasm.patch"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/on-thread-logger-on-wasm.patch"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/one-generation-reload-on-wasm.patch"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: quickshell resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

DEP_PREFIXES=(
    "$QTDECLARATIVE_PREFIX"
    "$QTSHADERTOOLS_PREFIX"
    "$QTBASE_PREFIX"
    "$CLI11_PREFIX"
    "$LIBDRM_PREFIX"
    "$WAYLAND_PROTOCOLS_PREFIX"
    "$LIBWAYLAND_PREFIX"
    "$LIBXKBCOMMON_PREFIX"
    "$FONTCONFIG_PREFIX"
    "$FREETYPE_PREFIX"
    "$HARFBUZZ_PREFIX"
    "$LIBPNG_PREFIX"
    "$LIBXML2_PREFIX"
    "$LIBFFI_PREFIX"
    "$LIBICONV_PREFIX"
    "$ZLIB_PREFIX"
    "$LIBCXX_PREFIX"
)

# pkg-config must see only the resolved dependency prefixes (the qtbase
# pattern: PKG_CONFIG_PATH leaves the host search path live). Quickshell
# pkg-configs libdrm and wayland-protocols (pkg_get_variable pkgdatadir).
PKG_CONFIG_LIBDIR="$(IFS=:; printf '%s' "${DEP_PREFIXES[*]/%//lib/pkgconfig}")"
PKG_CONFIG_LIBDIR="$PKG_CONFIG_LIBDIR:$WAYLAND_PROTOCOLS_PREFIX/share/pkgconfig"
export PKG_CONFIG_LIBDIR

CMAKE_PREFIXES="$(IFS=';'; printf '%s' "${DEP_PREFIXES[*]}")"

TARGET_DEFINES="-D__linux__=1 -DQT_LINUXBASE"

echo "==> Configuring quickshell for wasm32..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER=wasm32posix-cc \
    -DCMAKE_CXX_COMPILER=wasm32posix-c++ \
    -DCMAKE_AR="$(command -v wasm32posix-ar)" \
    -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
    -DCMAKE_C_FLAGS="$TARGET_DEFINES" \
    -DCMAKE_CXX_FLAGS="$TARGET_DEFINES -fwasm-exceptions" \
    `# MinSizeRel, not Release: the browser compiles the linked module once per worker thread, so code size multiplies across workers (docs/browser-support.md#quickshell-qml-limits).` \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
    -DCMAKE_CXX_STANDARD_LIBRARIES="$LIBFFI_PREFIX/lib/libffi.a $LIBXML2_PREFIX/lib/libxml2.a $LIBICONV_PREFIX/lib/libiconv.a $LIBICONV_PREFIX/lib/libcharset.a $SYSROOT/lib/libgbm.a -lc++ -lc++abi" \
    -DCMAKE_EXE_LINKER_FLAGS="-L$LIBWAYLAND_PREFIX/lib" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_PREFIX_PATH="$CMAKE_PREFIXES" \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF \
    -DQT_HOST_PATH="$QT_HOST_PATH" \
    -DQT_ADDITIONAL_PACKAGES_PREFIX_PATH="$QTDECLARATIVE_PREFIX;$QTSHADERTOOLS_PREFIX" \
    -DCMAKE_DISABLE_FIND_PACKAGE_harfbuzz=ON \
    -DWAYLAND=ON \
    -DWAYLAND_WLR_LAYERSHELL=ON \
    -DSOCKETS=OFF \
    -DCRASH_HANDLER=OFF \
    -DUSE_JEMALLOC=OFF \
    -DX11=OFF \
    -DI3=OFF \
    -DHYPRLAND=OFF \
    -DSCREENCOPY=OFF \
    -DWAYLAND_SESSION_LOCK=OFF \
    -DWAYLAND_TOPLEVEL_MANAGEMENT=OFF \
    -DSERVICE_STATUS_NOTIFIER=OFF \
    -DSERVICE_PIPEWIRE=OFF \
    -DSERVICE_MPRIS=OFF \
    -DSERVICE_PAM=OFF \
    -DSERVICE_POLKIT=OFF \
    -DSERVICE_GREETD=OFF \
    -DSERVICE_UPOWER=OFF \
    -DSERVICE_NOTIFICATIONS=OFF \
    -DBLUETOOTH=OFF \
    -DNETWORK=OFF

echo "==> Building quickshell..."
cmake --build "$BUILD_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

QS_BIN="$BUILD_DIR/src/launch/quickshell"
if [ ! -f "$QS_BIN" ]; then
    QS_BIN="$(find "$BUILD_DIR" -type f -name quickshell -perm -u+x | head -1)"
fi
if [ -z "$QS_BIN" ] || [ ! -f "$QS_BIN" ]; then
    echo "ERROR: Build failed — quickshell executable not found under $BUILD_DIR" >&2
    exit 1
fi

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary quickshell "$QS_BIN" "quickshell.wasm"

echo "==> quickshell $QUICKSHELL_VERSION built for wasm32"
