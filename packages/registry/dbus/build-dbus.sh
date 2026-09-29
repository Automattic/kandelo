#!/usr/bin/env bash
#
# Build dbus 1.14.10 (dbus-daemon, dbus-send, dbus-monitor) for
# wasm32-posix-kernel.
#
# 1.14 is the last autotools series (1.16 moved to meson/cmake), so the
# port rides the standard configure cross-compile pattern with ac_cv
# overrides instead of a meson bypass. Session-bus scope per plan §4
# (PR22): no systemd/selinux/apparmor/audit, no launchd, no X11, no
# traditional (setuid helper) activation, no inotify/kqueue dir
# watching, and no Linux abstract sockets — the kernel serves path
# AF_UNIX sockets only.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve dbus`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR        # where declared [[outputs]] land
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#     WASM_POSIX_DEP_EXPAT_DIR      # resolved expat prefix (direct dep)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR/dbus-work" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/dbus-src"

DBUS_VERSION="${WASM_POSIX_DEP_VERSION:-${DBUS_VERSION:-1.14.10}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://dbus.freedesktop.org/releases/dbus/dbus-${DBUS_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-ba1f21d2bd9d339da2d4aa8780c09df32fea87998b73da24f49ab9df1e36a50f}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

EXPAT_PREFIX="${WASM_POSIX_DEP_EXPAT_DIR:?WASM_POSIX_DEP_EXPAT_DIR not set (must be invoked via cargo xtask build-deps resolve dbus)}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage the resolver-verified source ---
# The resolver acquires and verifies the archive before this script runs, so
# stage its tree rather than fetch the tarball a second time.
echo "==> Staging verified dbus $DBUS_VERSION source..."
rm -rf "$SRC_DIR"
kandelo_package_stage_verified_source dbus "$SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
BUILD_DIR="$SCRIPT_DIR/dbus-build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "==> Configuring dbus for wasm32 (expat at $EXPAT_PREFIX)..."
(
    cd "$BUILD_DIR"
    # The SDK links with -Wl,--allow-undefined, so every AC_CHECK_FUNCS
    # link test "succeeds" — functions the sysroot lacks must be forced
    # off or their guarded includes/calls break the build (getpeerucred
    # pulls Solaris ucred.h) or trap at runtime as null table entries.
    CFLAGS="-O2" \
    ac_cv_have_abstract_sockets=no \
    ac_cv_func_getpeereid=no \
    ac_cv_func_getpeerucred=no \
    ac_cv_func__NSGetEnviron=no \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix=/usr \
        --sysconfdir=/etc \
        --localstatedir=/var \
        --runstatedir=/run \
        --enable-static \
        --disable-shared \
        --disable-systemd \
        --disable-selinux \
        --disable-apparmor \
        --disable-libaudit \
        --disable-launchd \
        --disable-kqueue \
        --disable-inotify \
        --disable-traditional-activation \
        --disable-tests \
        --disable-installed-tests \
        --disable-doxygen-docs \
        --disable-xml-docs \
        --disable-ducktype-docs \
        --disable-user-session \
        --without-x \
        --with-session-socket-dir=/tmp \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        CPPFLAGS="-I$EXPAT_PREFIX/include" \
        LDFLAGS="-L$EXPAT_PREFIX/lib" \
        EXPAT_CFLAGS="-I$EXPAT_PREFIX/include" \
        EXPAT_LIBS="-L$EXPAT_PREFIX/lib -lexpat"

    echo "==> Building dbus..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
)

for bin in bus/dbus-daemon tools/dbus-send tools/dbus-monitor; do
    if [ ! -f "$BUILD_DIR/$bin" ]; then
        echo "ERROR: $bin not found after build" >&2
        exit 1
    fi
done

# install_local_binary applies fork instrumentation (policy auto) and
# also stages each output into WASM_POSIX_DEP_OUT_DIR for the resolver.
source "$REPO_ROOT/scripts/install-local-binary.sh"
mkdir -p "$SCRIPT_DIR/bin"
for out in dbus-daemon dbus-send dbus-monitor; do
    case "$out" in
        dbus-daemon) src="$BUILD_DIR/bus/$out" ;;
        *)           src="$BUILD_DIR/tools/$out" ;;
    esac
    cp "$src" "$SCRIPT_DIR/bin/$out.wasm"
    install_local_binary dbus "$SCRIPT_DIR/bin/$out.wasm"
done

echo "==> dbus $DBUS_VERSION built successfully!"
ls -lh "$SCRIPT_DIR/bin/"*.wasm
