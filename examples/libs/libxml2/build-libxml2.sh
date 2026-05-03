#!/usr/bin/env bash
#
# Build libxml2 (libxml2.a) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libxml2`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR        # where to install
#     WASM_POSIX_DEP_VERSION        # upstream version
#     WASM_POSIX_DEP_SOURCE_URL     # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256  # expected sha256 of the tarball
#     WASM_POSIX_DEP_ZLIB_DIR       # resolved zlib prefix (direct dep)
#
# For ad-hoc / legacy invocation (`bash build-libxml2.sh`), the script
# falls back to the in-tree `libxml2-install/` layout and to a
# sibling-built zlib under `$SCRIPT_DIR/../zlib/zlib-install`.
#
# We drive `configure` to generate `config.h` + `xmlversion.h` but
# compile + archive by hand: libtool mishandles wasm .o file naming
# when crossing through `ar`, so the direct-compile path is more
# reliable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/libxml2-src"

# --- Inputs from resolver, with legacy fallbacks ---
LIBXML2_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBXML2_VERSION:-2.13.8}}"
LIBXML2_MAJOR_MINOR="${LIBXML2_VERSION%.*}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxml2-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/libxml2/${LIBXML2_MAJOR_MINOR}/libxml2-${LIBXML2_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Locate zlib ---
# Resolver surfaces the direct-dep install path via contract env var.
# Legacy mode falls back to the sibling zlib-install dir that
# `build-zlib.sh` lays down (also our historical layout).
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    LEGACY_ZLIB="$SCRIPT_DIR/../zlib/zlib-install"
    if [ ! -f "$LEGACY_ZLIB/lib/libz.a" ]; then
        echo "==> Building zlib (legacy path)..."
        bash "$SCRIPT_DIR/../zlib/build-zlib.sh"
    fi
    ZLIB_PREFIX="$LEGACY_ZLIB"
fi

if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib not found at $ZLIB_PREFIX" >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libxml2 $LIBXML2_VERSION..."
    TARBALL="/tmp/libxml2-${LIBXML2_VERSION}.tar.xz"
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

cd "$SRC_DIR"

# --- Configure (regenerate config.h against the current ZLIB_PREFIX) ---
# Scrub any stale config so probes re-run. Cheap; no object-compile wasted.
echo "==> Configuring libxml2 for Wasm (zlib at $ZLIB_PREFIX)..."
make distclean 2>/dev/null || true
rm -f config.h config.status

wasm32posix-configure \
    --disable-shared --enable-static \
    --without-python --without-readline --without-iconv \
    --without-icu --without-lzma --without-http --without-ftp \
    --without-threads \
    --with-zlib="$ZLIB_PREFIX" \
    --prefix="$INSTALL_DIR" \
    CFLAGS="-O2"

# Compile directly without libtool. Source list mirrors Makefile.am's
# libxml2_la_SOURCES plus the modules our `configure` run enables.
SOURCES=(
    buf.c chvalid.c dict.c entities.c encoding.c error.c
    globals.c hash.c list.c parser.c parserInternals.c
    SAX.c SAX2.c threads.c tree.c uri.c valid.c
    xmlIO.c xmlmemory.c xmlstring.c
    c14n.c catalog.c
    HTMLparser.c HTMLtree.c
    legacy.c
    pattern.c relaxng.c
    xmlmodule.c xmlreader.c xmlregexp.c xmlsave.c
    xmlschemas.c xmlschemastypes.c xmlunicode.c
    xmlwriter.c xpath.c xpointer.c xinclude.c xlink.c
    schematron.c
)

CFLAGS="-O2 -DHAVE_CONFIG_H -I. -I./include"

echo "==> Compiling libxml2 source files..."
OBJS=()
for src in "${SOURCES[@]}"; do
    if [ -f "$src" ]; then
        obj="${src%.c}.o"
        # shellcheck disable=SC2086
        wasm32posix-cc $CFLAGS -c "$src" -o "$obj"
        OBJS+=("$obj")
    fi
done

echo "==> Creating libxml2.a (${#OBJS[@]} objects)..."
wasm32posix-ar rcs libxml2.a "${OBJS[@]}"

# --- Install ---
echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include/libxml" "$INSTALL_DIR/lib/pkgconfig"

cp libxml2.a "$INSTALL_DIR/lib/"
cp include/libxml/*.h "$INSTALL_DIR/include/libxml/"

# pkg-config file — write a self-contained copy that points at
# INSTALL_DIR. Consumers outside the resolver can still read Libs.private
# to pull zlib in via their own means.
cat > "$INSTALL_DIR/lib/pkgconfig/libxml-2.0.pc" <<PCEOF
prefix=$INSTALL_DIR
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: libXML
Description: libXML library version2.
Version: $LIBXML2_VERSION
Requires:
Libs: -L\${libdir} -lxml2
Libs.private: -lz -lm
Cflags: -I\${includedir}/libxml
PCEOF

if [ -f "$INSTALL_DIR/lib/libxml2.a" ]; then
    echo "==> libxml2 build complete!"
    ls -lh "$INSTALL_DIR/lib/libxml2.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libxml2.a" >&2
    exit 1
fi
