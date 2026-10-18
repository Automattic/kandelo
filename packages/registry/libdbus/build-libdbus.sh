#!/usr/bin/env bash
#
# Build libdbus-1 (the D-Bus client library, static) for wasm32-posix-kernel
# from dbus 1.14.10, the release the `dbus` package builds its session
# daemon from. Same autotools configure, same session-bus scope, same
# ac_cv overrides (see packages/registry/dbus/build-dbus.sh); only the
# library subtree is built and installed.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libdbus`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR        # where declared [outputs] land
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#     WASM_POSIX_DEP_EXPAT_DIR      # resolved expat prefix (direct dep)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/libdbus-src"
BUILD_DIR="$WORK_DIR/libdbus-build"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$WORK_DIR/libdbus-install}"

DBUS_VERSION="${WASM_POSIX_DEP_VERSION:-1.14.10}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://dbus.freedesktop.org/releases/dbus/dbus-${DBUS_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-ba1f21d2bd9d339da2d4aa8780c09df32fea87998b73da24f49ab9df1e36a50f}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

EXPAT_PREFIX="${WASM_POSIX_DEP_EXPAT_DIR:?WASM_POSIX_DEP_EXPAT_DIR not set (must be invoked via cargo xtask build-deps resolve libdbus)}"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

echo "==> Staging verified dbus $DBUS_VERSION source..."
rm -rf "$SRC_DIR"
kandelo_package_stage_verified_source libdbus "$SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

# Fresh build dir each run: autoconf bakes --prefix into the Makefiles.
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
# The resolver owns INSTALL_DIR and records its inode; empty it in place.
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete

echo "==> Configuring libdbus for wasm32 (expat at $EXPAT_PREFIX)..."
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
        --prefix="$INSTALL_DIR" \
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

    echo "==> Building libdbus-1..."
    make -C dbus -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libdbus-1.la
    echo "==> Installing libdbus-1 to $INSTALL_DIR..."
    make -C dbus install
    make install-pkgconfigDATA
)

# configure baked the resolver's staging path into the .pc; the resolver
# publishes the prefix elsewhere, so point it at the file's own location
# the way libdrm.pc does.
PC="$INSTALL_DIR/lib/pkgconfig/dbus-1.pc"
sed -i.bak 's|^prefix=.*|prefix=${pcfiledir}/../..|' "$PC"
rm -f "$PC.bak"
rm -f "$INSTALL_DIR/lib/libdbus-1.la"

for f in \
    lib/libdbus-1.a \
    include/dbus-1.0/dbus/dbus.h \
    lib/dbus-1.0/include/dbus/dbus-arch-deps.h \
    lib/pkgconfig/dbus-1.pc
do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        echo "ERROR: expected libdbus output missing: $f" >&2
        exit 1
    fi
done

echo "==> libdbus $DBUS_VERSION built for wasm32"
ls -lh "$INSTALL_DIR/lib/libdbus-1.a"
