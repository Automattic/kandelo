#!/usr/bin/env bash
#
# Build Waybar 0.14.0 (waybar.wasm) for wasm32-posix-kernel.
#
# Waybar is meson-only, so this is a meson bypass (docs/porting-guide.md):
# wayland-scanner generates the protocol glue, then the upstream
# meson.build's source list — core + the dep-free compositor module
# families (sway, hyprland, river, dwl, niri, wayfire, wlr-taskbar) +
# the is_linux block — compiles with wasm32posix-c++. Optional-dep
# modules stay out exactly as a meson build without those deps would
# leave them. simpleclock.cpp replaces clock.cpp: no chrono-timezone
# database exists on this libc++ (LIBCXX_ENABLE_RANDOM_DEVICE=OFF tree,
# no tzdb), matching meson's no-tz_dep branch.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve waybar`, env vars are set by the
# resolver: WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256, plus WASM_POSIX_DEP_<DEP>_DIR per depends_on entry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/waybar-src"

WAYBAR_VERSION="${WASM_POSIX_DEP_VERSION:-0.14.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/waybar-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/Alexays/Waybar/archive/refs/tags/${WAYBAR_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/waybar-build"

for tool in wasm32posix-c++ wasm32posix-cc wayland-scanner; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

GTKMM3_PREFIX="${WASM_POSIX_DEP_GTKMM3_DIR:?WASM_POSIX_DEP_GTKMM3_DIR not set (must be invoked via cargo xtask build-deps resolve waybar)}"
GTK_LAYER_SHELL_PREFIX="${WASM_POSIX_DEP_GTK_LAYER_SHELL_DIR:?WASM_POSIX_DEP_GTK_LAYER_SHELL_DIR not set}"
GLIBMM_PREFIX="${WASM_POSIX_DEP_GLIBMM_DIR:?WASM_POSIX_DEP_GLIBMM_DIR not set}"
CAIROMM_PREFIX="${WASM_POSIX_DEP_CAIROMM_DIR:?WASM_POSIX_DEP_CAIROMM_DIR not set}"
PANGOMM_PREFIX="${WASM_POSIX_DEP_PANGOMM_DIR:?WASM_POSIX_DEP_PANGOMM_DIR not set}"
ATKMM_PREFIX="${WASM_POSIX_DEP_ATKMM_DIR:?WASM_POSIX_DEP_ATKMM_DIR not set}"
LIBSIGCXX_PREFIX="${WASM_POSIX_DEP_LIBSIGCXX_DIR:?WASM_POSIX_DEP_LIBSIGCXX_DIR not set}"
JSONCPP_PREFIX="${WASM_POSIX_DEP_JSONCPP_DIR:?WASM_POSIX_DEP_JSONCPP_DIR not set}"
SPDLOG_PREFIX="${WASM_POSIX_DEP_SPDLOG_DIR:?WASM_POSIX_DEP_SPDLOG_DIR not set}"
FMT_PREFIX="${WASM_POSIX_DEP_FMT_DIR:?WASM_POSIX_DEP_FMT_DIR not set}"
LIBXKBREGISTRY_PREFIX="${WASM_POSIX_DEP_LIBXKBREGISTRY_DIR:?WASM_POSIX_DEP_LIBXKBREGISTRY_DIR not set}"
GTK3_PREFIX="${WASM_POSIX_DEP_GTK3_DIR:?WASM_POSIX_DEP_GTK3_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
ATK_PREFIX="${WASM_POSIX_DEP_ATK_DIR:?WASM_POSIX_DEP_ATK_DIR not set}"
PANGO_PREFIX="${WASM_POSIX_DEP_PANGO_DIR:?WASM_POSIX_DEP_PANGO_DIR not set}"
CAIRO_PREFIX="${WASM_POSIX_DEP_CAIRO_DIR:?WASM_POSIX_DEP_CAIRO_DIR not set}"
GDK_PIXBUF_PREFIX="${WASM_POSIX_DEP_GDK_PIXBUF_DIR:?WASM_POSIX_DEP_GDK_PIXBUF_DIR not set}"
HARFBUZZ_PREFIX="${WASM_POSIX_DEP_HARFBUZZ_DIR:?WASM_POSIX_DEP_HARFBUZZ_DIR not set}"
FRIBIDI_PREFIX="${WASM_POSIX_DEP_FRIBIDI_DIR:?WASM_POSIX_DEP_FRIBIDI_DIR not set}"
LIBEPOXY_PREFIX="${WASM_POSIX_DEP_LIBEPOXY_DIR:?WASM_POSIX_DEP_LIBEPOXY_DIR not set}"
PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
LIBPNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?WASM_POSIX_DEP_LIBPNG_DIR not set}"
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set}"
PROTOCOLS_XML="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}/xml"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:?WASM_POSIX_DEP_PCRE2_DIR not set}"
# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot waybar "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading Waybar $WAYBAR_VERSION..."
    TARBALL="/tmp/waybar-${WAYBAR_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: waybar resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
GEN="$BUILD_DIR/protocol"
mkdir -p "$BUILD_DIR" "$GEN" "$INSTALL_DIR"

# --- Protocol glue (mirrors protocol/meson.build) -----------------------
echo "==> Generating protocol glue with $(wayland-scanner --version 2>&1 | head -1)..."
gen_protocol() {
    local xml="$1"
    local base
    base="$(basename "$xml" .xml)"
    wayland-scanner private-code   "$xml" "$GEN/$base-protocol.c"
    wayland-scanner client-header  "$xml" "$GEN/$base-client-protocol.h"
}
gen_protocol "$PROTOCOLS_XML/xdg-shell.xml"
gen_protocol "$PROTOCOLS_XML/xdg-output-unstable-v1.xml"
gen_protocol "$PROTOCOLS_XML/idle-inhibit-unstable-v1.xml"
gen_protocol "$SRC_DIR/protocol/wlr-foreign-toplevel-management-unstable-v1.xml"
gen_protocol "$SRC_DIR/protocol/river-status-unstable-v1.xml"
gen_protocol "$SRC_DIR/protocol/river-control-unstable-v1.xml"
gen_protocol "$SRC_DIR/protocol/dwl-ipc-unstable-v2.xml"

# --- Compile ------------------------------------------------------------
INCLUDES=(
    "-I$SRC_DIR/include"
    "-I$GEN"
    "-I$GTKMM3_PREFIX/include/gtkmm-3.0"    "-I$GTKMM3_PREFIX/lib/gtkmm-3.0/include"
    "-I$GTKMM3_PREFIX/include/gdkmm-3.0"    "-I$GTKMM3_PREFIX/lib/gdkmm-3.0/include"
    "-I$ATKMM_PREFIX/include/atkmm-1.6"     "-I$ATKMM_PREFIX/lib/atkmm-1.6/include"
    "-I$PANGOMM_PREFIX/include/pangomm-1.4" "-I$PANGOMM_PREFIX/lib/pangomm-1.4/include"
    "-I$CAIROMM_PREFIX/include/cairomm-1.0" "-I$CAIROMM_PREFIX/lib/cairomm-1.0/include"
    "-I$GLIBMM_PREFIX/include/glibmm-2.4"   "-I$GLIBMM_PREFIX/lib/glibmm-2.4/include"
    "-I$GLIBMM_PREFIX/include/giomm-2.4"    "-I$GLIBMM_PREFIX/lib/giomm-2.4/include"
    "-I$LIBSIGCXX_PREFIX/include/sigc++-2.0" "-I$LIBSIGCXX_PREFIX/lib/sigc++-2.0/include"
    "-I$GTK_LAYER_SHELL_PREFIX/include/gtk-layer-shell"
    "-I$GTK3_PREFIX/include/gtk-3.0"
    "-I$ATK_PREFIX/include/atk-1.0"
    "-I$GDK_PIXBUF_PREFIX/include/gdk-pixbuf-2.0"
    "-I$PANGO_PREFIX/include/pango-1.0"
    "-I$CAIRO_PREFIX/include/cairo"
    "-I$GLIB_PREFIX/include/glib-2.0"       "-I$GLIB_PREFIX/lib/glib-2.0/include"
    "-I$HARFBUZZ_PREFIX/include/harfbuzz"
    "-I$LIBEPOXY_PREFIX/include"
    "-I$JSONCPP_PREFIX/include"
    "-I$SPDLOG_PREFIX/include"
    "-I$FMT_PREFIX/include"
    "-I$LIBXKBREGISTRY_PREFIX/include"
    "-I$LIBXKBCOMMON_PREFIX/include"
    "-I$LIBWAYLAND_PREFIX/include"
    "-I$FONTCONFIG_PREFIX/include"
    "-I$FREETYPE_PREFIX/include/freetype2"
)

DEFINES=(
    "-DVERSION=\"$WAYBAR_VERSION\""
    "-DSYSCONFDIR=\"/etc\""
    -DSPDLOG_COMPILED_LIB
    -DSPDLOG_FMT_EXTERNAL
    -DHAVE_SWAY
    -DHAVE_WLR_TASKBAR
    -DHAVE_RIVER
    -DHAVE_DWL
    -DHAVE_HYPRLAND
    -DHAVE_NIRI
    -DHAVE_WAYFIRE
)

# Upstream src_files for this feature set: core + sway + wlr-taskbar +
# river + dwl + hyprland + niri + wayfire + simpleclock. The is_linux
# block (battery, cpu, memory, bluetooth, systemd units, power
# profiles, cffi) stays out: those modules read /proc, /sys, inotify
# and logind, none of which this kernel serves, and their headers are
# guarded on __linux__ — which wasm32-unknown-unknown does not define.
# meson reaches the same set on a non-Linux host.
TUS=(
    src/factory.cpp
    src/AModule.cpp
    src/ALabel.cpp
    src/AIconLabel.cpp
    src/AAppIconLabel.cpp
    src/ASlider.cpp
    src/main.cpp
    src/bar.cpp
    src/client.cpp
    src/config.cpp
    src/group.cpp
    src/modules/custom.cpp
    src/modules/disk.cpp
    src/modules/idle_inhibitor.cpp
    src/modules/image.cpp
    src/modules/load.cpp
    src/modules/temperature.cpp
    src/modules/user.cpp
    src/modules/simpleclock.cpp
    # factory.cpp constructs CFFI unconditionally, so this TU is not
    # optional the way meson's is_linux placement suggests. It needs
    # only dlfcn.h, which this kernel serves.
    src/modules/cffi.cpp
    src/modules/sway/ipc/client.cpp
    src/modules/sway/bar.cpp
    src/modules/sway/mode.cpp
    src/modules/sway/language.cpp
    src/modules/sway/window.cpp
    src/modules/sway/workspaces.cpp
    src/modules/sway/scratchpad.cpp
    src/modules/wlr/taskbar.cpp
    src/modules/river/layout.cpp
    src/modules/river/mode.cpp
    src/modules/river/tags.cpp
    src/modules/river/window.cpp
    src/modules/dwl/tags.cpp
    src/modules/dwl/window.cpp
    src/modules/hyprland/backend.cpp
    src/modules/hyprland/language.cpp
    src/modules/hyprland/submap.cpp
    src/modules/hyprland/window.cpp
    src/modules/hyprland/windowcount.cpp
    src/modules/hyprland/workspace.cpp
    src/modules/hyprland/workspaces.cpp
    src/modules/hyprland/windowcreationpayload.cpp
    src/modules/niri/backend.cpp
    src/modules/niri/language.cpp
    src/modules/niri/window.cpp
    src/modules/niri/workspaces.cpp
    src/modules/wayfire/backend.cpp
    src/modules/wayfire/window.cpp
    src/modules/wayfire/workspaces.cpp
    src/util/portal.cpp
    src/util/enum.cpp
    src/util/prepare_for_sleep.cpp
    src/util/ustring_clen.cpp
    src/util/sanitize_str.cpp
    src/util/rewrite_string.cpp
    src/util/gtk_icon.cpp
    src/util/icon_loader.cpp
    src/util/regex_collection.cpp
    src/util/css_reload_helper.cpp
)

NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
echo "==> Compiling ${#TUS[@]} C++ TUs + protocol glue for wasm32 (-j$NCPU)..."
compile_cxx() {
    local tu="$1"
    local obj="$BUILD_DIR/$(echo "$tu" | sed 's#/#_#g; s#\.cpp$#.o#')"
    wasm32posix-c++ -c -std=c++20 -O2 -fwasm-exceptions \
        "${DEFINES[@]}" "${INCLUDES[@]}" \
        "$SRC_DIR/$tu" -o "$obj"
}
for tu in "${TUS[@]}"; do
    while [ "$(jobs -rp | wc -l)" -ge "$NCPU" ]; do wait -n; done
    echo "    $tu" >&2
    compile_cxx "$tu" &
done
wait

PROTO_OBJS=()
for c in "$GEN"/*-protocol.c; do
    obj="$BUILD_DIR/$(basename "$c" .c).o"
    wasm32posix-cc -c -O2 "-I$GEN" "-I$LIBWAYLAND_PREFIX/include" "$c" -o "$obj"
    PROTO_OBJS+=("$obj")
done
wasm32posix-cc -c -O2 "$SCRIPT_DIR/src/glib-static-init.c" \
    -o "$BUILD_DIR/glib-static-init.o"

OBJS=()
for tu in "${TUS[@]}"; do
    OBJS+=("$BUILD_DIR/$(echo "$tu" | sed 's#/#_#g; s#\.cpp$#.o#')")
done

# Link order is semantic on wasm-ld (dependents before dependencies,
# libffi after glib, libc++ last) — the gtk3_smoke closure in
# scripts/build-programs.sh is the model. gdk-wayland's EGL/dmabuf path
# reaches the sysroot GL + gbm/drm stubs (built by build-musl.sh and
# build-gles-stubs.sh), the same archives every DRI program links.
echo "==> Linking waybar.wasm..."
wasm32posix-c++ "${OBJS[@]}" "${PROTO_OBJS[@]}" \
    "$BUILD_DIR/glib-static-init.o" \
    "$GTK_LAYER_SHELL_PREFIX/lib/libgtk-layer-shell.a" \
    "$GTKMM3_PREFIX/lib/libgtkmm-3.0.a" \
    "$GTKMM3_PREFIX/lib/libgdkmm-3.0.a" \
    "$ATKMM_PREFIX/lib/libatkmm-1.6.a" \
    "$PANGOMM_PREFIX/lib/libpangomm-1.4.a" \
    "$CAIROMM_PREFIX/lib/libcairomm-1.0.a" \
    "$GLIBMM_PREFIX/lib/libgiomm-2.4.a" \
    "$GLIBMM_PREFIX/lib/libglibmm-2.4.a" \
    "$LIBSIGCXX_PREFIX/lib/libsigc-2.0.a" \
    "$JSONCPP_PREFIX/lib/libjsoncpp.a" \
    "$SPDLOG_PREFIX/lib/libspdlog.a" \
    "$FMT_PREFIX/lib/libfmt.a" \
    "$LIBXKBREGISTRY_PREFIX/lib/libxkbregistry.a" \
    "$GTK3_PREFIX/lib/libgtk-3.a" \
    "$GTK3_PREFIX/lib/libgdk-3.a" \
    "$ATK_PREFIX/lib/libatk-1.0.a" \
    "$GDK_PIXBUF_PREFIX/lib/libgdk_pixbuf-2.0.a" \
    "$LIBEPOXY_PREFIX/lib/libepoxy.a" \
    "$LIBWAYLAND_PREFIX/lib/libwayland-client.a" \
    "$LIBWAYLAND_PREFIX/lib/libwayland-cursor.a" \
    "$LIBWAYLAND_PREFIX/lib/libwayland-egl.a" \
    "$LIBXKBCOMMON_PREFIX/lib/libxkbcommon.a" \
    "$PANGO_PREFIX/lib/libpangocairo-1.0.a" \
    "$PANGO_PREFIX/lib/libpangoft2-1.0.a" \
    "$PANGO_PREFIX/lib/libpango-1.0.a" \
    "$CAIRO_PREFIX/lib/libcairo-gobject.a" \
    "$CAIRO_PREFIX/lib/libcairo.a" \
    "$HARFBUZZ_PREFIX/lib/libharfbuzz.a" \
    "$FRIBIDI_PREFIX/lib/libfribidi.a" \
    "$GLIB_PREFIX/lib/libgio-2.0.a" \
    "$GLIB_PREFIX/lib/libgobject-2.0.a" \
    "$GLIB_PREFIX/lib/libgmodule-2.0.a" \
    "$GLIB_PREFIX/lib/libglib-2.0.a" \
    "$PCRE2_PREFIX/lib/libpcre2-8.a" \
    "$LIBFFI_PREFIX/lib/libffi.a" \
    "$PIXMAN_PREFIX/lib/libpixman-1.a" \
    "$FONTCONFIG_PREFIX/lib/libfontconfig.a" \
    "$FREETYPE_PREFIX/lib/libfreetype.a" \
    "$LIBXML2_PREFIX/lib/libxml2.a" \
    "$LIBPNG_PREFIX/lib/libpng.a" \
    "$ZLIB_PREFIX/lib/libz.a" \
    "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
    "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
    "$SYSROOT/lib/libc++.a" \
    "$SYSROOT/lib/libc++abi.a" \
    -o "$BUILD_DIR/waybar.wasm"

# Waybar's custom modules and on-click actions run through fork+exec.
echo "==> Instrumenting fork paths..."
bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$BUILD_DIR/waybar.wasm" -o "$BUILD_DIR/waybar.wasm.instr"
mv "$BUILD_DIR/waybar.wasm.instr" "$BUILD_DIR/waybar.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$BUILD_DIR/waybar.wasm" "$INSTALL_DIR/waybar.wasm"
install_local_binary waybar "$BUILD_DIR/waybar.wasm"

echo "==> Waybar $WAYBAR_VERSION build complete!"
ls -lh "$INSTALL_DIR/waybar.wasm"
