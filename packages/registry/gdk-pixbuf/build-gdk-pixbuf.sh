#!/usr/bin/env bash
#
# Build gdk-pixbuf 2.36.12 (libgdk_pixbuf-2.0.a) for wasm32-posix-kernel.
#
# 2.36.12 is the last autotools release (2.38 moved to meson), so the
# port rides the standard configure cross-compile pattern. Scope per
# plan §4 (PR24): the png loader only, compiled in statically — no
# jpeg/tiff, no dynamic loader modules.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve gdk-pixbuf`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix
#     WASM_POSIX_DEP_LIBPNG_DIR       # resolved libpng prefix

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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/gdk-pixbuf-src"

GDK_PIXBUF_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/gdk-pixbuf-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/gdk-pixbuf-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set (must be invoked via cargo xtask build-deps resolve gdk-pixbuf)}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified gdk-pixbuf $GDK_PIXBUF_VERSION source..."
    kandelo_package_stage_verified_source gdk-pixbuf "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: gdk-pixbuf resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

PC_PATH="$GLIB_PREFIX/lib/pkgconfig:$LIBPNG_PREFIX/lib/pkgconfig"

echo "==> Configuring gdk-pixbuf for wasm32..."
(
    cd "$BUILD_DIR"
    # glib's pc files reference -lffi / -lz by bare name; the build's
    # own executables (timescale, gdk-pixbuf-csource) need the search
    # paths.
    #
    # --localedir is set even though --disable-nls installs no catalogue:
    # GNOME_LOCALEDIR is compiled in regardless, and left to autoconf it
    # derives from --prefix, which is the resolver's per-invocation
    # staging directory — a host path deleted at publication, and
    # different between two builds of this recipe.
    CFLAGS="-O2" \
    LDFLAGS="-L$LIBFFI_PREFIX/lib -L$ZLIB_PREFIX/lib" \
    PKG_CONFIG_PATH="$PC_PATH" \
    gio_can_sniff=no \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --disable-modules \
        --with-included-loaders=png \
        --without-libjpeg \
        --without-libtiff \
        --disable-glibtest \
        --enable-introspection=no \
        --disable-gtk-doc \
        --disable-nls \
        --localedir=/usr/share/locale \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building gdk-pixbuf..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gdk-pixbuf

    echo "==> Installing to $INSTALL_DIR..."
    make -C gdk-pixbuf install
    make install-pkgconfigDATA
)

# The loaders are compiled in, so the query/csource tools (wasm
# binaries) have no consumer; drop them from the install tree.
rm -rf "$INSTALL_DIR/bin"

# glib-genmarshal names its input list, by absolute path, in a comment
# above every marshaller in the installed gdk-pixbuf-marshal.h. Under the
# resolver that path is the work root, whose name carries the builder's
# PID. Map it to the name the SDK driver gives the same tree in compiled
# objects, and fail if the work root reaches any other installed file.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    while IFS= read -r -d '' header; do
        if grep -qF "$KANDELO_PACKAGE_WORK_DIR" "$header"; then
            KANDELO_FROM="$KANDELO_PACKAGE_WORK_DIR" \
            KANDELO_TO="/usr/src/kandelo-build/gdk-pixbuf" \
                perl -pi -e 's/\Q$ENV{KANDELO_FROM}\E/$ENV{KANDELO_TO}/g' "$header"
        fi
    done < <(find "$INSTALL_DIR/include" -type f -name '*.h' -print0)
    if grep -rlF "$KANDELO_PACKAGE_WORK_DIR" "$INSTALL_DIR" >&2; then
        echo "ERROR: installed gdk-pixbuf files above embed the resolver work root" >&2
        exit 1
    fi
fi

if [ -f "$INSTALL_DIR/lib/libgdk_pixbuf-2.0.a" ]; then
    echo "==> gdk-pixbuf build complete!"
    ls -lh "$INSTALL_DIR/lib/libgdk_pixbuf-2.0.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libgdk_pixbuf-2.0.a" >&2
    exit 1
fi
