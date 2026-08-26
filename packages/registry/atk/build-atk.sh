#!/usr/bin/env bash
#
# Build atk 2.36.0 (libatk-1.0.a) for wasm32-posix-kernel.
#
# GTK 3.24.34 requires atk >= 2.32; the last autotools atk is 2.28, so
# this port bypasses meson the same way build-glib.sh does: hand-written
# config.h, enum types via glib-mkenums, marshallers via
# glib-genmarshal, then a direct compile of the upstream meson TU list
# (atk/meson.build atk_sources).
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve atk`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_GLIB_DIR         # resolved glib prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/atk-src"

ATK_VERSION="${WASM_POSIX_DEP_VERSION:-2.36.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/atk-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://download.gnome.org/sources/atk/2.36/atk-${ATK_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/atk-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set (must be invoked via cargo xtask build-deps resolve atk)}"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading atk $ATK_VERSION..."
    TARBALL="/tmp/atk-${ATK_VERSION}.tar.xz"
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
    # Hand-written get_type functions cast 1-argument class/iface init
    # functions to the 2-argument GClassInitFunc / GInterfaceInitFunc.
    # Native ABIs tolerate the extra arguments; wasm's typed
    # call_indirect traps on them. See docs/porting-guide.md
    # "Callback casts that change arity".
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-callback-arity.patch"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: atk resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR/atk" "$INSTALL_DIR/lib"

# Upstream meson version scheme: interface_age 1,
# binary_age = 10000*major + 100*minor + 10 + micro.
ATK_MAJOR=2
ATK_MINOR=36
ATK_MICRO=0
ATK_INTERFACE_AGE=1
ATK_BINARY_AGE=$((10000 * ATK_MAJOR + 100 * ATK_MINOR + 10 + ATK_MICRO))

echo "==> Generating config.h, atkversion.h, enum types, marshallers..."
cat > "$BUILD_DIR/config.h" <<EOF
#define VERSION "$ATK_VERSION"
#define GETTEXT_PACKAGE "atk10"
#define HAVE_BIND_TEXTDOMAIN_CODESET 1
EOF

sed -e "s/@ATK_MAJOR_VERSION@/$ATK_MAJOR/" \
    -e "s/@ATK_MINOR_VERSION@/$ATK_MINOR/" \
    -e "s/@ATK_MICRO_VERSION@/$ATK_MICRO/" \
    -e "s/@ATK_INTERFACE_AGE@/$ATK_INTERFACE_AGE/" \
    -e "s/@ATK_BINARY_AGE@/$ATK_BINARY_AGE/" \
    "$SRC_DIR/atk/atkversion.h.in" > "$BUILD_DIR/atk/atkversion.h"

# The upstream meson atk_headers list (atk/meson.build) — mkenums input
# order matters for reproducible enum output.
ATK_HEADERS=(
    atkaction.h atkcomponent.h atkdocument.h atkeditabletext.h
    atkgobjectaccessible.h atkhyperlink.h atkhyperlinkimpl.h
    atkhypertext.h atkimage.h atkmisc.h atknoopobject.h
    atknoopobjectfactory.h atkobject.h atkobjectfactory.h atkplug.h
    atkrange.h atkregistry.h atkrelation.h atkrelationtype.h
    atkrelationset.h atkselection.h atksocket.h atkstate.h
    atkstateset.h atkstreamablecontent.h atktable.h atktablecell.h
    atktext.h atkutil.h atkvalue.h atkwindow.h
)
HEADER_PATHS=()
for h in "${ATK_HEADERS[@]}"; do
    HEADER_PATHS+=("$SRC_DIR/atk/$h")
done

python3 "$GLIB_PREFIX/bin/glib-mkenums" \
    --template "$SRC_DIR/atk/atk-enum-types.h.template" \
    "${HEADER_PATHS[@]}" > "$BUILD_DIR/atk/atk-enum-types.h"
python3 "$GLIB_PREFIX/bin/glib-mkenums" \
    --template "$SRC_DIR/atk/atk-enum-types.c.template" \
    "${HEADER_PATHS[@]}" > "$BUILD_DIR/atk-enum-types.c"

python3 "$GLIB_PREFIX/bin/glib-genmarshal" --prefix atk_marshal \
    --header "$SRC_DIR/atk/atkmarshal.list" > "$BUILD_DIR/atkmarshal.h"
echo '#include "atkmarshal.h"' > "$BUILD_DIR/atkmarshal.c"
python3 "$GLIB_PREFIX/bin/glib-genmarshal" --prefix atk_marshal \
    --body "$SRC_DIR/atk/atkmarshal.list" >> "$BUILD_DIR/atkmarshal.c"

CFLAGS=(
    -O2 -std=gnu99
    -DHAVE_CONFIG_H
    '-DG_LOG_DOMAIN="Atk"'
    -DG_LOG_USE_STRUCTURED=1
    -DGLIB_DISABLE_DEPRECATION_WARNINGS
    -DATK_DISABLE_DEPRECATION_WARNINGS
    -DATK_COMPILATION
    '-DATK_LOCALEDIR="/usr/share/locale"'
    -DG_DISABLE_SINGLE_INCLUDES
    -DATK_DISABLE_SINGLE_INCLUDES
    "-I$BUILD_DIR"
    "-I$BUILD_DIR/atk"
    "-I$SRC_DIR"
    "-I$SRC_DIR/atk"
    "-I$GLIB_PREFIX/include/glib-2.0"
)

# Upstream meson atk_sources list (atk/meson.build) + the generated
# enum-types and marshaller TUs.
ATK_TUS=(
    atkaction.c atkcomponent.c atkdocument.c atkeditabletext.c
    atkgobjectaccessible.c atkhyperlink.c atkhyperlinkimpl.c
    atkhypertext.c atkimage.c atknoopobject.c atknoopobjectfactory.c
    atkobject.c atkobjectfactory.c atkplug.c atkprivate.c atkrange.c
    atkregistry.c atkrelation.c atkrelationset.c atkselection.c
    atksocket.c atkstate.c atkstateset.c atkstreamablecontent.c
    atktable.c atktablecell.c atktext.c atkutil.c atkmisc.c atkvalue.c
    atkversion.c atkwindow.c
)

echo "==> Compiling atk..."
OBJS=()
for tu in "${ATK_TUS[@]}"; do
    echo "    atk/$tu"
    obj="$BUILD_DIR/${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/atk/$tu" -o "$obj"
    OBJS+=("$obj")
done
for tu in atk-enum-types.c atkmarshal.c; do
    echo "    $tu"
    obj="$BUILD_DIR/${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$BUILD_DIR/$tu" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Archiving..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libatk-1.0.a" "${OBJS[@]}"

echo "==> Installing headers..."
INC="$INSTALL_DIR/include/atk-1.0/atk"
mkdir -p "$INC"
for h in "${ATK_HEADERS[@]}" atk.h; do
    cp "$SRC_DIR/atk/$h" "$INC/"
done
cp "$BUILD_DIR/atk/atkversion.h" "$BUILD_DIR/atk/atk-enum-types.h" "$INC/"

echo "==> Writing pkg-config file..."
PC_DIR="$INSTALL_DIR/lib/pkgconfig"
mkdir -p "$PC_DIR"
cat > "$PC_DIR/atk.pc" <<EOF
prefix=$INSTALL_DIR
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: Atk
Description: Accessibility Toolkit for wasm32-posix-kernel (static)
Version: $ATK_VERSION
Requires: gobject-2.0
Libs: -L\${libdir} -latk-1.0
Cflags: -I\${includedir}/atk-1.0
EOF

echo "==> atk $ATK_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libatk-1.0.a"
