#!/usr/bin/env bash
#
# Build libepoxy 1.5.4 (libepoxy.a) for wasm32-posix-kernel.
#
# The release tarball is the raw git tag — no pre-generated configure —
# so the script runs autoreconf first. EGL dispatch only, no GLX, no
# X11: GTK3's wayland backend compiles against epoxy/egl.h, and epoxy
# resolves GL symbols by dlopen at first call, so no GL library is
# required until a GL context is actually created.
#
# The EGL platform headers (EGL/eglplatform.h, KHR/khrplatform.h) and
# the headers-only egl.pc stub that configure's PKG_CHECK_MODULES(EGL)
# requires come from src/ in this package.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libepoxy`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libepoxy-src"

LIBEPOXY_VERSION="${WASM_POSIX_DEP_VERSION:-1.5.4}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libepoxy-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/anholt/libepoxy/releases/download/${LIBEPOXY_VERSION}/libepoxy-${LIBEPOXY_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/libepoxy-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libepoxy $LIBEPOXY_VERSION..."
    TARBALL="/tmp/libepoxy-${LIBEPOXY_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

if [ ! -f "$SRC_DIR/configure" ]; then
    echo "==> Generating configure with autoreconf..."
    (cd "$SRC_DIR" && mkdir -p m4 && autoreconf --install)
fi

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libepoxy resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

# Headers-only egl.pc for configure's PKG_CHECK_MODULES(EGL); the
# installed copy below points at the install prefix instead.
PC_DIR="$BUILD_DIR/pkgconfig"
mkdir -p "$PC_DIR"
cat > "$PC_DIR/egl.pc" <<EOF
Name: egl
Description: EGL platform types for wasm32-posix-kernel (headers only)
Version: 1.5
Cflags: -I$SCRIPT_DIR/src
EOF

echo "==> Configuring libepoxy for wasm32..."
(
    cd "$BUILD_DIR"
    CFLAGS="-O2" \
    PKG_CONFIG_PATH="$PC_DIR" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --enable-egl=yes \
        --enable-glx=no \
        --enable-x11=no \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building libepoxy..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C src

    echo "==> Installing to $INSTALL_DIR..."
    make -C src install
    make -C include/epoxy install
    make install-pkgconfigDATA
)

cp -R "$SCRIPT_DIR/src/EGL" "$SCRIPT_DIR/src/KHR" "$INSTALL_DIR/include/"
cat > "$INSTALL_DIR/lib/pkgconfig/egl.pc" <<EOF
prefix=$INSTALL_DIR
includedir=\${prefix}/include

Name: egl
Description: EGL platform types for wasm32-posix-kernel (headers only)
Version: 1.5
Cflags: -I\${includedir}
EOF

if [ -f "$INSTALL_DIR/lib/libepoxy.a" ]; then
    echo "==> libepoxy build complete!"
    ls -lh "$INSTALL_DIR/lib/libepoxy.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libepoxy.a" >&2
    exit 1
fi
