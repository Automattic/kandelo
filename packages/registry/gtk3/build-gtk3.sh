#!/usr/bin/env bash
#
# Build GTK 3.24.34 (libgdk-3.a + libgtk-3.a) for wasm32-posix-kernel.
#
# 3.24.34 is the last autotools release (3.24.35 moved to meson), so
# the port rides the standard configure cross-compile pattern. Wayland
# backend only: no X11, no broadway, no win32/quartz, no cups/papi
# print backends, no dynamic modules.
#
# The wayland protocol glue is generated at build time by the host
# wayland-scanner (flake.nix) from two places: XML bundled in the GTK
# tarball (gtk-shell, gtk-primary-selection, server-decoration) and
# XML from the wayland-protocols package, which configure finds through
# its wayland-protocols.pc pkgdatadir.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve gtk3`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR                    # install prefix
#     WASM_POSIX_DEP_VERSION                    # upstream version
#     WASM_POSIX_DEP_SOURCE_URL                 # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256              # expected sha256
#     WASM_POSIX_DEP_GLIB_DIR                   # resolved glib prefix
#     WASM_POSIX_DEP_ATK_DIR                    # resolved atk prefix
#     WASM_POSIX_DEP_PANGO_DIR                  # resolved pango prefix
#     WASM_POSIX_DEP_CAIRO_DIR                  # resolved cairo prefix
#     WASM_POSIX_DEP_GDK_PIXBUF_DIR             # resolved gdk-pixbuf prefix
#     WASM_POSIX_DEP_LIBEPOXY_DIR               # resolved libepoxy prefix
#     WASM_POSIX_DEP_FRIBIDI_DIR                # resolved fribidi prefix
#     WASM_POSIX_DEP_HARFBUZZ_DIR               # resolved harfbuzz prefix
#     WASM_POSIX_DEP_FONTCONFIG_DIR             # resolved fontconfig prefix
#     WASM_POSIX_DEP_FREETYPE_DIR               # resolved freetype prefix
#     WASM_POSIX_DEP_PIXMAN_DIR                 # resolved pixman prefix
#     WASM_POSIX_DEP_LIBPNG_DIR                 # resolved libpng prefix
#     WASM_POSIX_DEP_LIBWAYLAND_DIR             # resolved libwayland prefix
#     WASM_POSIX_DEP_LIBXKBCOMMON_DIR           # resolved libxkbcommon prefix
#     WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR  # resolved wayland-protocols prefix

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
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/gtk3-src"

GTK3_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/gtk3-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/gtk3-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set (must be invoked via cargo xtask build-deps resolve gtk3)}"
ATK_PREFIX="${WASM_POSIX_DEP_ATK_DIR:?WASM_POSIX_DEP_ATK_DIR not set}"
PANGO_PREFIX="${WASM_POSIX_DEP_PANGO_DIR:?WASM_POSIX_DEP_PANGO_DIR not set}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
GDK_PIXBUF_PREFIX="${WASM_POSIX_DEP_GDK_PIXBUF_DIR:?WASM_POSIX_DEP_GDK_PIXBUF_DIR not set}"
LIBEPOXY_PREFIX="${WASM_POSIX_DEP_LIBEPOXY_DIR:?WASM_POSIX_DEP_LIBEPOXY_DIR not set}"
FRIBIDI_PREFIX="${WASM_POSIX_DEP_FRIBIDI_DIR:?WASM_POSIX_DEP_FRIBIDI_DIR not set}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:?WASM_POSIX_DEP_LIBCXX_DIR not set}"
LIBICONV_PREFIX="${WASM_POSIX_DEP_LIBICONV_DIR:?WASM_POSIX_DEP_LIBICONV_DIR not set}"
WAYLAND_PROTOCOLS_PREFIX="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified gtk+ $GTK3_VERSION source..."
    kandelo_package_stage_verified_source gtk3 "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
    # Signal handlers connected with fewer arguments than the signal
    # (default_display_notify_cb, display_opened_cb, display_closed_cb)
    # get their full marshal arity. Native ABIs tolerate the extra
    # arguments; wasm's typed call_indirect traps on them. See
    # docs/porting-guide.md "Callback casts that change arity".
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-callback-arity.patch"
    # Match the getter definition and declaration: wasm calls have exact arity.
    # Upstream fix: GNOME/gtk 022c36a1379d82b4212a298ed6eaec02bc0ed7f1.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/fix-slowdown-prototype.patch"
    # GDK backs its wl_shm pools with memfd_create/shm_open. A memfd is
    # private to the process that made it here, so the compositor's
    # gbm_bo_import(GBM_BO_IMPORT_FD) rejects the fd and the window shows
    # no pixels. The patch allocates the pool as a DRI bo instead — the
    # same shape foot and mako already use.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wayland-shm-gbm-pool.patch"
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-interface-init-contract.patch"
    # Base application virtuals must preserve their exact function signatures.
    patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-application-default-vfuncs.patch"
    # Connected GTK widget signals preserve the closure userdata argument.
    patch --fuzz=0 -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-widget-signal-contracts.patch"
    # Closure/weak cleanup retains the public two-argument notifier contract.
    patch --fuzz=0 -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/wasm-closure-notifier-contract.patch"
fi

# Fresh build dir each run — autoconf bakes --prefix into Makefiles.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: gtk3 resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$BUILD_DIR"

# No --disable-cloudproviders: gtk's AC_ARG_ENABLE(cloudproviders) sets
# cloudproviders_set=yes on ANY spelling of the flag, which makes the
# libcloudproviders probe a hard requirement. Omitting the flag keeps
# the integration off.

PC_DIR="$BUILD_DIR/pkgconfig"
mkdir -p "$PC_DIR"

# iso-codes is a data-only package (language/country names for the
# font chooser); gtk's configure probes the module. Absent data at
# runtime GTK falls back to raw ISO codes.
cat > "$PC_DIR/iso-codes.pc" <<EOF
prefix=/usr/share
domains=iso_639-2 iso_3166-1

Name: iso-codes
Description: ISO code lists stub for wasm32-posix-kernel (no data)
Version: 4.16.0
EOF

PC_PATH="$PC_DIR"
for prefix in "$GLIB_PREFIX" "$ATK_PREFIX" "$PANGO_PREFIX" "$CAIRO_PREFIX" \
              "$GDK_PIXBUF_PREFIX" "$LIBEPOXY_PREFIX" "$FRIBIDI_PREFIX" \
              "$HARFBUZZ_PREFIX" "$FONTCONFIG_PREFIX" "$FREETYPE_PREFIX" \
              "$PIXMAN_PREFIX" "$LIBPNG_PREFIX" "$LIBWAYLAND_PREFIX" \
              "$LIBXKBCOMMON_PREFIX"; do
    PC_PATH="$PC_PATH:$prefix/lib/pkgconfig"
done
# wayland-protocols is data-only: upstream installs its .pc under
# share/pkgconfig.
PC_PATH="$PC_PATH:$WAYLAND_PROTOCOLS_PREFIX/share/pkgconfig"
# cairo and pango are meson-built static libraries, so their .pc files
# list every link dependency as a public Requires (zlib, pixman,
# libxml2 via fontconfig, ...). pkg-config needs the whole closure,
# which the resolver composes.
PC_PATH="$PC_PATH:${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set}"

echo "==> Configuring gtk+ for wasm32..."
(
    cd "$BUILD_DIR"
    # The wasm gio-2.0.pc has no glib_compile_resources variable — the
    # tool is a compiled host binary (flake.nix pkgs.glib.dev), so the
    # env override supplies it. glib's pc files reference -lffi / -lz
    # by bare name; the build's own executables need the search paths.
    #
    # LIBS completes the static link of the executables gtk builds
    # (gtk-launch, gtk-builder-tool, gtk-query-settings); no .pc file this
    # configure reads lists these, and a link without them fails on the
    # undefined symbols:
    #   - libEGL, libGLESv2, libgbm, libdrm (base sysroot):
    #     wayland-shm-gbm-pool.patch makes GDK allocate its wl_shm pools
    #     with libgbm, and libwayland-egl calls libgbm and libEGL;
    #   - libiconv: fontconfig parses its configuration with libxml2, and
    #     this libxml2 converts encodings through GNU libiconv;
    #   - libc++, libc++abi: pango shapes through harfbuzz, which is C++.
    # They are named as -l flags with their directories in LDFLAGS, never
    # as archive paths: libtool unpacks an archive path it finds among a
    # static library's dependencies and merges its members into that
    # library, which corrupts libgdk-3.a.
    CFLAGS="-O2" \
    LDFLAGS="-L$LIBFFI_PREFIX/lib -L$ZLIB_PREFIX/lib -L$LIBICONV_PREFIX/lib -L$LIBCXX_PREFIX/lib" \
    LIBS="-lEGL -lGLESv2 -lgbm -ldrm -liconv -lc++ -lc++abi" \
    PKG_CONFIG_PATH="$PC_PATH" \
    GLIB_COMPILE_RESOURCES="$(command -v glib-compile-resources)" \
    "$SRC_DIR/configure" \
        --host=wasm32-unknown-none \
        --prefix="$INSTALL_DIR" \
        --enable-static \
        --disable-shared \
        --enable-wayland-backend \
        --disable-x11-backend \
        --disable-win32-backend \
        --disable-quartz-backend \
        --disable-broadway-backend \
        --disable-modules \
        --disable-cups \
        --disable-papi \
        --enable-colord=no \
        --disable-glibtest \
        --enable-introspection=no \
        --disable-gtk-doc \
        --enable-man=no \
        --disable-nls \
        CC=wasm32posix-cc \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib

    echo "==> Building gdk..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gdk
    echo "==> Building gtk..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C gtk

    echo "==> Installing to $INSTALL_DIR..."
    make -C gdk install
    make -C gtk install
    make install-pkgconfigDATA
)

# The Wayland pool patch gives GDK a direct GBM dependency. Configure's
# LIBS above links GTK's own tools but is not exported by upstream's .pc
# templates; every static GDK consumer needs this dependency too.
for name in gdk-3.0 gdk-wayland-3.0; do
    pc="$INSTALL_DIR/lib/pkgconfig/$name.pc"
    if ! grep -q '^Requires.private:' "$pc"; then
        echo "ERROR: GDK pkg-config metadata lacks Requires.private: $pc" >&2
        exit 1
    fi
    sed '/^Requires.private:/s/$/ gbm/' "$pc" > "$pc.tmp"
    mv "$pc.tmp" "$pc"
done

for lib in libgdk-3.a libgtk-3.a; do
    if [ ! -f "$INSTALL_DIR/lib/$lib" ]; then
        echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/$lib" >&2
        exit 1
    fi
done

echo "==> gtk+ $GTK3_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/"libg*k-3.a
