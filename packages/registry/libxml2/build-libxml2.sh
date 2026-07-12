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
#     WASM_POSIX_DEP_LIBICONV_DIR   # resolved GNU libiconv prefix (direct dep)
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
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-libxml2.XXXXXX")"
cleanup() {
    if [ "${WASM_POSIX_KEEP_BUILD_DIR:-0}" = "1" ]; then
        echo "==> Preserving libxml2 build directory: $WORK_DIR" >&2
    else
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT
SRC_DIR="$WORK_DIR/source"

# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

# --- Inputs from resolver, with legacy fallbacks ---
LIBXML2_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBXML2_VERSION:-2.13.8}}"
LIBXML2_MAJOR_MINOR="${LIBXML2_VERSION%.*}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxml2-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/libxml2/${LIBXML2_MAJOR_MINOR}/libxml2-${LIBXML2_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: libxml2 currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Locate zlib / libiconv ---
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

LIBICONV_PREFIX="${WASM_POSIX_DEP_LIBICONV_DIR:-}"
if [ -z "$LIBICONV_PREFIX" ]; then
    LEGACY_LIBICONV="$SCRIPT_DIR/../libiconv/libiconv-install"
    if [ ! -f "$LEGACY_LIBICONV/lib/libiconv.a" ]; then
        echo "==> Building GNU libiconv (legacy path)..."
        bash "$SCRIPT_DIR/../libiconv/build-libiconv.sh"
    fi
    LIBICONV_PREFIX="$LEGACY_LIBICONV"
fi

if [ ! -f "$LIBICONV_PREFIX/lib/libiconv.a" ]; then
    echo "ERROR: GNU libiconv not found at $LIBICONV_PREFIX" >&2
    exit 1
fi

# --- Fetch + verify source ---
echo "==> Downloading libxml2 $LIBXML2_VERSION..."
TARBALL="$WORK_DIR/libxml2.tar.xz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"

# --- Configure against the resolver-provided dependencies ---
echo "==> Configuring libxml2 for Wasm (zlib at $ZLIB_PREFIX)..."

DEP_PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$LIBICONV_PREFIX/lib/pkgconfig"
if [ -n "${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" ]; then
    DEP_PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH:$WASM_POSIX_DEP_PKG_CONFIG_PATH"
fi
if [ -n "${PKG_CONFIG_PATH:-}" ]; then
    DEP_PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH:$PKG_CONFIG_PATH"
fi

# Autoconf's unprototyped AC_CHECK_LIB calls can produce temporarily
# signature-mismatched Wasm that Binaryen rightly rejects. Keep configure
# probes unoptimized; the actual archive is compiled at -O2 below.
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" wasm32posix-configure \
    --disable-shared --enable-static \
    --without-python --without-readline \
    --without-icu --without-lzma --without-http --without-ftp \
    --without-threads \
    --with-zlib="$ZLIB_PREFIX" \
    --with-iconv="$LIBICONV_PREFIX" \
    --prefix=/usr \
    CPPFLAGS="-I$ZLIB_PREFIX/include -I$LIBICONV_PREFIX/include" \
    CFLAGS="-O0" \
    LDFLAGS="-L$ZLIB_PREFIX/lib -L$LIBICONV_PREFIX/lib"

if ! awk '
    /^#if 1$/ { enabled = 1; next }
    enabled && /^#define LIBXML_ZLIB_ENABLED$/ { found = 1 }
    /^#endif$/ { enabled = 0 }
    END { exit found ? 0 : 1 }
' include/libxml/xmlversion.h; then
    echo "ERROR: libxml2 configure did not enable declared zlib support" >&2
    exit 1
fi

# libxml2 2.13.8's debug shell uses POSIX access(2) without including
# <unistd.h>. Native builds can inherit an implicit declaration from permissive
# compiler modes; Kandelo's C99 cross-build rejects that upstream omission.
if ! grep -q "kandelo-posix-access-declaration" debugXML.c; then
    python3 - <<'PY'
from pathlib import Path

p = Path("debugXML.c")
s = p.read_text()
marker = "#include <stdlib.h>\n"
replacement = marker + "#include <unistd.h> /* kandelo-posix-access-declaration */\n"
if marker not in s:
    raise SystemExit("libxml2 debugXML include marker not found")
p.write_text(s.replace(marker, replacement, 1))
PY
fi

# Compile directly without libtool. Source list mirrors Makefile.am's
# libxml2_la_SOURCES plus the modules our `configure` run enables.
SOURCES=(
    buf.c chvalid.c dict.c entities.c encoding.c error.c
    globals.c hash.c list.c parser.c parserInternals.c
    SAX.c SAX2.c threads.c tree.c uri.c valid.c
    xmlIO.c xmlmemory.c xmlstring.c
    c14n.c catalog.c
    debugXML.c
    HTMLparser.c HTMLtree.c
    legacy.c
    pattern.c relaxng.c
    xmlmodule.c xmlreader.c xmlregexp.c xmlsave.c
    xmlschemas.c xmlschemastypes.c xmlunicode.c
    xmlwriter.c xpath.c xpointer.c xinclude.c xlink.c
    schematron.c
)

CFLAGS="-O2 -DHAVE_CONFIG_H -I. -I./include -I$ZLIB_PREFIX/include -I$LIBICONV_PREFIX/include"

echo "==> Compiling libxml2 source files..."
OBJS=()
for src in "${SOURCES[@]}"; do
    if [ ! -f "$src" ]; then
        echo "ERROR: declared libxml2 source missing: $src" >&2
        exit 1
    fi
    obj="${src%.c}.o"
    # shellcheck disable=SC2086
    wasm32posix-cc $CFLAGS -c "$src" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Creating libxml2.a (${#OBJS[@]} objects)..."
wasm32posix-ar rcs libxml2.a "${OBJS[@]}"

# --- Install ---
echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include/libxml" "$INSTALL_DIR/lib/pkgconfig"

cp libxml2.a "$INSTALL_DIR/lib/"
cp include/libxml/*.h "$INSTALL_DIR/include/libxml/"

# Write relocatable pkg-config metadata. The resolver supplies direct
# dependency prefixes through PKG_CONFIG_PATH, so Requires.private carries
# their search paths without baking a producer's cache directory into this
# archive.
cat > "$INSTALL_DIR/lib/pkgconfig/libxml-2.0.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: libXML
Description: libXML library version2.
Version: $LIBXML2_VERSION
Requires.private: libiconv zlib
Libs: -L\${libdir} -lxml2
Libs.private: -lm
Cflags: -I\${includedir}
PCEOF

if [ -f "$INSTALL_DIR/lib/libxml2.a" ]; then
    echo "==> libxml2 build complete!"
    ls -lh "$INSTALL_DIR/lib/libxml2.a"
else
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libxml2.a" >&2
    exit 1
fi
