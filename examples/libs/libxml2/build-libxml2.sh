#!/usr/bin/env bash
set -euo pipefail

LIBXML2_VERSION="${LIBXML2_VERSION:-2.13.8}"
LIBXML2_MAJOR_MINOR="${LIBXML2_VERSION%.*}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libxml2-src"
INSTALL_DIR="$SCRIPT_DIR/libxml2-install"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_SYSROOT="$SYSROOT"

# Ensure zlib is built and installed into sysroot (libxml2 depends on it)
ZLIB_DIR="$SCRIPT_DIR/../zlib/zlib-install"
if [ ! -f "$ZLIB_DIR/lib/libz.a" ]; then
    echo "==> Building zlib..."
    bash "$SCRIPT_DIR/../zlib/build-zlib.sh"
fi
cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$ZLIB_DIR/lib/pkgconfig/zlib.pc" \
    > "$SYSROOT/lib/pkgconfig/zlib.pc"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libxml2 $LIBXML2_VERSION..."
    TARBALL="libxml2-${LIBXML2_VERSION}.tar.xz"
    curl -fsSL "https://download.gnome.org/sources/libxml2/$LIBXML2_MAJOR_MINOR/$TARBALL" \
        -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xJf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
fi

cd "$SRC_DIR"

# Run configure to generate config.h and xmlversion.h, but we won't use make
echo "==> Configuring libxml2 for Wasm..."
if [ ! -f config.h ]; then
    wasm32posix-configure \
        --disable-shared --enable-static \
        --without-python --without-readline --without-iconv \
        --without-icu --without-lzma --without-http --without-ftp \
        --without-threads \
        --with-zlib="$SYSROOT" \
        --prefix="$INSTALL_DIR" \
        CFLAGS="-O2"
fi

# Compile directly without libtool (libtool mishandles wasm .o file naming).
# Source list from Makefile.am's libxml2_la_SOURCES.
SOURCES=(
    buf.c chvalid.c dict.c entities.c encoding.c error.c
    globals.c hash.c list.c parser.c parserInternals.c
    SAX.c SAX2.c threads.c tree.c uri.c valid.c
    xmlIO.c xmlmemory.c xmlstring.c
    # Optional modules enabled by configure
    c14n.c catalog.c debugXML.c
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
        wasm32posix-cc $CFLAGS -c "$src" -o "$obj"
        OBJS+=("$obj")
    fi
done

echo "==> Creating libxml2.a (${#OBJS[@]} objects)..."
wasm32posix-ar rcs libxml2.a "${OBJS[@]}"

# Install
echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include/libxml" "$INSTALL_DIR/lib/pkgconfig"

cp libxml2.a "$INSTALL_DIR/lib/"
cp include/libxml/*.h "$INSTALL_DIR/include/libxml/"

# Create pkg-config file
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
    echo "ERROR: Build failed — library not found" >&2
    exit 1
fi
