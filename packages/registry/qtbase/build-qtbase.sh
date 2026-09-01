#!/usr/bin/env bash
#
# Build Qt 6.10.2 QtCore, QtGui, QtWidgets, QtWaylandClient, QtConcurrent
# and QtXml (static) for wasm32-posix-kernel.
#
# Qt 6.10 moved the Wayland client platform plugin out of qtwayland and
# into qtbase (src/plugins/platforms/wayland), so this one package
# delivers the whole client side: QtWaylandClient, the `wayland` QPA
# plugin and the xdg-shell integration. That subdirectory returns early
# unless QT_FEATURE_wayland and QT_FEATURE_waylandscanner both hold —
# the first needs the registry's libwayland, the second the host
# wayland-scanner. It then drives Qt6::qtwaylandscanner, which nixpkgs'
# darwin qtbase does not ship and flake.nix builds instead
# (nix/qtwaylandscanner/).
#
# Qt is the first dependency here that cannot use the meson-bypass
# technique (docs/porting-guide.md): moc, rcc and uic codegen is woven
# through qtbase's sources, so it drives its own CMake. The
# generators run on the build machine and come from the flake's pinned
# Qt through QT_HOST_PATH; CMake rejects a host/target version mismatch,
# so the two versions move together.
#
# Three target adaptations, each for a stated reason:
#
#   -D__linux__=1   qsystemdetection.h:134 has no wasm branch and errors
#                   out. CMAKE_SYSTEM_NAME only settles the build
#                   system; the headers read preprocessor macros, and
#                   this toolchain defines __unix__ but not __linux__.
#                   The sysroot is the musl userland Qt expects. Same
#                   lever basu, erlang and spidermonkey already use; the
#                   SDK withholds it globally on purpose (sdk/config.site).
#
#   -DQT_LINUXBASE  Qt's own switch for a Linux userland without the
#                   futex syscall (qfutex_p.h:41), which this kernel is.
#                   It also steers Qt off glibc-only paths — backtrace,
#                   inotify syscall stubs, sched_getaffinity — toward
#                   the portable ones. Two upstream sites forgot to
#                   honour it; src/qmutex-honour-qt-linuxbase.patch
#                   fixes those.
#
#   src/include     supplies the empty <linux/fs.h> QtCore includes.
#
# OpenGL is off, so the Wayland client runs on wl_shm alone. Qt refuses
# that through INPUT_opengl rather than FEATURE_opengl: gui/configure.cmake
# raises a hard error unless the input reads exactly 'no'. QtQuick will
# need a graphics API, so the GL stack is the next stage's problem.
#
# On this kernel a wl_shm pool fd must be a DRI prime fd — the
# compositor imports it with gbm_bo_import(GBM_BO_IMPORT_FD), and a
# memfd carries no pixels across the socket.
# src/wayland-shm-gbm-pool.patch backs Qt's shm backing store with a
# renderD128 gbm bo, the same contract foot and GTK are patched to.
# Programs linking libQt6WaylandClient.a link libgbm.a and libdrm.a
# from the sysroot.
#
# Vulkan and LinuxFB are the two backends QtGui switches on by itself
# here — Vulkan against Qt's bundled headers, LinuxFB against a
# framebuffer device this target does not have. Both are named off. The
# rest need a library the resolved prefixes do not carry, so they settle
# off on their own and are not listed.
#
# The markdown reader uses Qt's bundled md4c. Left to auto-detection,
# configure finds the build machine's md4c — the resolved prefixes
# carry none — and Qt6Gui's dependency interface then links that host
# .dylib into every CMake consumer's target executables.
#
# FEATURE_process is on, carried by src/forkfd-generic-on-wasm.patch.
# Qt defines __linux__ here (see above), which routes its bundled forkfd
# to forkfd_linux.c — raw clone(2) does not exist on this kernel, and
# musl's clone() references __post_Fork, pulling musl's _Fork.o and
# duplicating the glue's _Fork at link. The patch keeps wasm on forkfd's
# generic fork() fallback, which routes through the glue's kernel_fork;
# the kernel's waitid(WNOWAIT) and SIGCHLD delivery carry the rest.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve qtbase`, env vars are set by the
# resolver: WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256, plus WASM_POSIX_DEP_<DEP>_DIR per depends_on entry:
#     WASM_POSIX_DEP_LIBCXX_DIR        WASM_POSIX_DEP_HARFBUZZ_DIR
#     WASM_POSIX_DEP_ZLIB_DIR          WASM_POSIX_DEP_LIBPNG_DIR
#     WASM_POSIX_DEP_FREETYPE_DIR      WASM_POSIX_DEP_LIBXKBCOMMON_DIR
#     WASM_POSIX_DEP_FONTCONFIG_DIR    WASM_POSIX_DEP_LIBWAYLAND_DIR

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/qtbase-src"

QTBASE_VERSION="${WASM_POSIX_DEP_VERSION:-6.10.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/qtbase-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.qt.io/archive/qt/6.10/${QTBASE_VERSION}/submodules/qtbase-everywhere-src-${QTBASE_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/qtbase-build"

for tool in wasm32posix-c++ wasm32posix-cc cmake ninja qmake strings; do
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
if [ "$HOST_QT_VERSION" != "$QTBASE_VERSION" ]; then
    echo "ERROR: host Qt $HOST_QT_VERSION cannot cross-build Qt $QTBASE_VERSION." >&2
    echo "       Qt requires an exact match. Realign flake.nix's pinned Qt" >&2
    echo "       and this recipe's version together." >&2
    exit 1
fi

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set (must be invoked via cargo xtask build-deps resolve qtbase)}"

# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot qtbase "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading qtbase $QTBASE_VERSION..."
    TARBALL="/tmp/qtbase-${QTBASE_VERSION}.tar.xz"
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
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/qmutex-honour-qt-linuxbase.patch"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wayland-shm-gbm-pool.patch"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/forkfd-generic-on-wasm.patch"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: qtbase resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

DEP_PREFIXES=(
    "$ZLIB_PREFIX"
    "$FREETYPE_PREFIX"
    "$FONTCONFIG_PREFIX"
    "$HARFBUZZ_PREFIX"
    "$LIBPNG_PREFIX"
    "$LIBXKBCOMMON_PREFIX"
    "$LIBWAYLAND_PREFIX"
)

# pkg-config must see only the resolved dependency prefixes. PKG_CONFIG_PATH
# prepends and leaves the host search path live, which lets Qt's configure
# find the build machine's glib and libb2; PKG_CONFIG_LIBDIR replaces it.
PKG_CONFIG_LIBDIR="$(IFS=:; printf '%s' "${DEP_PREFIXES[*]/%//lib/pkgconfig}")"
export PKG_CONFIG_LIBDIR

CMAKE_PREFIXES="$(IFS=';'; printf '%s' "${DEP_PREFIXES[*]}")"

TARGET_DEFINES="-D__linux__=1 -DQT_LINUXBASE -I$SCRIPT_DIR/src/include"

# Qt bakes its configure-time install prefix into QtCore as qt_prfxpath,
# which QLibraryInfo reads. Pointing that at the resolver's staging
# directory would write the builder's PID into libQt6Core.a and into
# every program linked against it, so two builds of the same source
# would differ. Configure against the guest path Qt will actually run
# under and relocate at install time; the baked string then describes
# the guest, not this machine.
GUEST_PREFIX="/usr/local/qt6"

echo "==> Configuring qtbase for wasm32..."
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
    -DQT_BUILD_TESTS=OFF \
    -DQT_QPA_DEFAULT_PLATFORM=wayland \
    -DFEATURE_gui=ON \
    -DFEATURE_freetype=ON \
    -DFEATURE_system_freetype=ON \
    -DFEATURE_fontconfig=ON \
    -DFEATURE_harfbuzz=ON \
    -DFEATURE_system_harfbuzz=ON \
    -DFEATURE_png=ON \
    -DFEATURE_system_png=ON \
    -DFEATURE_xkbcommon=ON \
    -DINPUT_opengl=no \
    -DFEATURE_vulkan=OFF \
    -DFEATURE_linuxfb=OFF \
    -DFEATURE_widgets=ON \
    -DFEATURE_network=ON \
    -DFEATURE_ssl=OFF \
    -DFEATURE_brotli=OFF \
    -DFEATURE_sql=OFF \
    -DFEATURE_testlib=OFF \
    -DFEATURE_dbus=OFF \
    -DFEATURE_process=ON \
    -DFEATURE_processenvironment=ON \
    -DFEATURE_qtwaylandscanner=ON \
    -DFEATURE_glib=OFF \
    -DFEATURE_icu=OFF \
    -DFEATURE_zstd=OFF \
    -DFEATURE_system_libb2=OFF \
    -DFEATURE_system_zlib=ON \
    -DFEATURE_system_pcre2=OFF \
    -DFEATURE_system_textmarkdownreader=OFF

echo "==> Building qtbase..."
cmake --build "$BUILD_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Installing to $INSTALL_DIR..."
cmake --install "$BUILD_DIR" --prefix "$INSTALL_DIR"

for lib in libQt6Core.a libQt6Gui.a libQt6Widgets.a libQt6Network.a libQt6WaylandClient.a libQt6Concurrent.a libQt6Xml.a libQt6BundledPcre2.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

# The staging directory name carries the builder's PID, so a leak here
# makes the package non-reproducible.
if strings "$INSTALL_DIR/lib/libQt6Core.a" | grep -q "build-stage"; then
    echo "ERROR: libQt6Core.a embeds the resolver staging path" >&2
    strings "$INSTALL_DIR/lib/libQt6Core.a" | grep "build-stage" | head -3 >&2
    exit 1
fi

echo "==> qtbase $QTBASE_VERSION built for wasm32"
