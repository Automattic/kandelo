#!/usr/bin/env bash
#
# Build the Wayland desktop: wlcompositor (server) plus the wlclock,
# wlpaint, wlterm and klauncher clients, notify-send, and stage the
# wldesktop launcher.
#
# The in-tree libraries these link (libwpkdraw, libkwl) have no upstream
# tarball, so the resolver does not own them — it walks packages/registry/
# only. They are compiled here into this package's PRIVATE sysroot, which
# also keeps the worktree sysroot untouched, as the package contract
# requires.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"

for f in programs/wlcompositor/wlcompositor.c programs/wlterm/wlterm.c \
         programs/wlterm/vt100.c programs/wlclock.c programs/wlpaint.c \
         programs/klauncher.c programs/notify-send.c \
         examples/libs/wpkdraw/src/wpkdraw.c examples/libs/wpkdraw/src/wpkfont.c \
         examples/libs/libkwl/src/kwl.c; do
    if [ ! -f "$SOURCE_ROOT/$f" ] || [ -L "$SOURCE_ROOT/$f" ]; then
        echo "ERROR: source must be a regular file: $SOURCE_ROOT/$f" >&2
        exit 1
    fi
done

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# A private sysroot seeded from the worktree SDK, with every resolved
# dependency projected into it. Never install into the shared worktree
# sysroot: a later package that seeds its own from it would inherit these
# archives, and `kandelo_package_require_regular_input_tree` rejects the whole
# tree if any entry is a symlink.
source "$REPO_ROOT/sdk/activate.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

for lib in libdrm libgbm libEGL libGLESv2; do
    if [ ! -f "$SDK_SYSROOT/lib/$lib.a" ]; then
        echo "ERROR: $lib.a missing from the SDK sysroot seed at $SDK_SYSROOT." >&2
        echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
        exit 1
    fi
done

export WASM_POSIX_DEP_WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$KANDELO_PACKAGE_WORK_DIR}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot wayland-demo "$SDK_SYSROOT" \
        libwayland libxkbcommon libinput libevdev libudev mtdev libffi \
        glib pcre2 zlib
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# libinput's public header and the wayland-protocols XML are read from their
# resolved prefixes directly; everything else is now inside $SYSROOT.
LIBINPUT="${WASM_POSIX_DEP_LIBINPUT_DIR:?resolve wayland-demo through cargo xtask build-deps}"
# wayland-protocols is a source-only dependency: it stages XML, not a
# lib/include prefix, so the resolver exports no *_DIR for it. The
# reviewed copy in-tree is the same file scripts/build-programs.sh scans.
PROTOCOLS="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:-}"

# --- Generate the Wayland protocol glue -------------------------------
GEN="$WORK_DIR/gen"
mkdir -p "$GEN"
# wayland-protocols installs its vendored XML at <prefix>/xml/ (see its
# package.toml [outputs].files). Prefer the resolved prefix; fall back to
# the reviewed in-tree copy for a direct, non-resolver invocation.
XML_DIR="$SOURCE_ROOT/packages/registry/wayland-protocols/xml"
if [ -n "$PROTOCOLS" ] && [ -d "$PROTOCOLS/xml" ]; then
    XML_DIR="$PROTOCOLS/xml"
fi
# stem:xml-basename. The generated header basenames are what the sources
# #include, so the stem is fixed by the consumer, not by the XML file name.
PROTOCOL_LIST=(
    "xdg-shell:xdg-shell"
    "linux-dmabuf-v1:linux-dmabuf-v1"
    "xdg-decoration-v1:xdg-decoration-unstable-v1"
    "wlr-layer-shell-v1:wlr-layer-shell-unstable-v1"
    "presentation-time:presentation-time"
    "xdg-output-v1:xdg-output-unstable-v1"
    "viewporter:viewporter"
    "fractional-scale-v1:fractional-scale-v1"
)
echo "==> Generating Wayland protocol glue from $XML_DIR..."
for entry in "${PROTOCOL_LIST[@]}"; do
    stem="${entry%%:*}"
    xml="$XML_DIR/${entry#*:}.xml"
    [ -f "$xml" ] || { echo "ERROR: protocol XML not found: $xml" >&2; exit 1; }
    wayland-scanner private-code  "$xml" "$GEN/$stem-protocol.c"
    wayland-scanner server-header "$xml" "$GEN/$stem-server-protocol.h"
    wayland-scanner client-header "$xml" "$GEN/$stem-client-protocol.h"
done

# --- In-tree libraries into the private sysroot -----------------------
LLVM_AR="$(command -v llvm-ar || command -v ar)"
CC_BIN="$(command -v wasm32posix-cc)"
echo "==> Building libwpkdraw..."
# BUILD_DIR keeps their objects and generated headers in this build's work
# dir: the source root may be the live checkout (repository provider), which
# a package build must not write into.
CC="$CC_BIN" AR="$LLVM_AR" BUILD_DIR="$WORK_DIR/wpkdraw" \
    bash "$SOURCE_ROOT/examples/libs/wpkdraw/build.sh" "$SYSROOT"
echo "==> Building libkwl..."
CC="$CC_BIN" AR="$LLVM_AR" XDG_SHELL_INCLUDE="$GEN" BUILD_DIR="$WORK_DIR/libkwl" \
    bash "$SOURCE_ROOT/examples/libs/libkwl/build.sh" "$SYSROOT"

PKG_CFLAGS="$(wasm32posix-pkg-config --cflags gbm libdrm egl glesv2)"
CFLAGS=(-std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -D_DEFAULT_SOURCE)

# --- wlcompositor -----------------------------------------------------
# Link order: dependents before dependencies; libffi last so
# wl_closure_invoke's ffi_call resolves.
echo "==> Building wlcompositor..."
wasm32posix-cc "${CFLAGS[@]}" -I"$GEN" -I"$LIBINPUT/include" $PKG_CFLAGS \
    "$SOURCE_ROOT/programs/wlcompositor/wlcompositor.c" \
    "$GEN/xdg-shell-protocol.c" \
    "$GEN/linux-dmabuf-v1-protocol.c" \
    "$GEN/xdg-decoration-v1-protocol.c" \
    "$GEN/wlr-layer-shell-v1-protocol.c" \
    "$GEN/presentation-time-protocol.c" \
    "$GEN/xdg-output-v1-protocol.c" \
    "$GEN/viewporter-protocol.c" \
    "$GEN/fractional-scale-v1-protocol.c" \
    "$SYSROOT/lib/libwayland-server.a" \
    "$SYSROOT/lib/libwpkdraw.a" \
    "$SYSROOT/lib/libxkbcommon.a" \
    "$SYSROOT/lib/libinput.a" \
    "$SYSROOT/lib/libevdev.a" \
    "$SYSROOT/lib/libudev.a" \
    "$SYSROOT/lib/libmtdev.a" \
    "$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a" \
    "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
    "$SYSROOT/lib/libffi.a" \
    -lm -o "$WORK_DIR/wlcompositor.wasm"

# --- libkwl clients ---------------------------------------------------
build_kwl_client() {
    local name="$1"; shift
    echo "==> Building $name..."
    wasm32posix-cc "${CFLAGS[@]}" -I"$GEN" $PKG_CFLAGS \
        "$@" \
        "$GEN/xdg-shell-protocol.c" \
        "$GEN/xdg-decoration-v1-protocol.c" \
        "$GEN/wlr-layer-shell-v1-protocol.c" \
        "$SYSROOT/lib/libkwl.a" \
        "$SYSROOT/lib/libwpkdraw.a" \
        "$SYSROOT/lib/libwayland-client.a" \
        "$SYSROOT/lib/libxkbcommon.a" \
        "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
        "$SYSROOT/lib/libffi.a" \
        -lm -o "$WORK_DIR/$name.wasm"
}
build_kwl_client wlclock "$SOURCE_ROOT/programs/wlclock.c"
build_kwl_client wlpaint "$SOURCE_ROOT/programs/wlpaint.c"
build_kwl_client wlterm  "$SOURCE_ROOT/programs/wlterm/wlterm.c" \
                         "$SOURCE_ROOT/programs/wlterm/vt100.c"
build_kwl_client klauncher "$SOURCE_ROOT/programs/klauncher.c"

# --- notify-send ------------------------------------------------------
# An org.freedesktop.Notifications client over glib's gdbus.
echo "==> Building notify-send..."
wasm32posix-cc "${CFLAGS[@]}" -I"$SYSROOT/include/glib-2.0" \
    "$SOURCE_ROOT/programs/notify-send.c" \
    "$SYSROOT/lib/libgio-2.0.a" \
    "$SYSROOT/lib/libgobject-2.0.a" \
    "$SYSROOT/lib/libgmodule-2.0.a" \
    "$SYSROOT/lib/libglib-2.0.a" \
    "$SYSROOT/lib/libpcre2-8.a" \
    "$SYSROOT/lib/libffi.a" \
    "$SYSROOT/lib/libz.a" \
    -lm -o "$WORK_DIR/notify-send.wasm"

# --- launchers and desktop data ----------------------------------------
# wldesktop starts the floating demo desktop; hyprdesktop and omarchydesktop
# start the tiling desktop and the Omarchy-shaped one. Their configs, themes
# and launcher entries are image data under /usr/share/kandelo, packed into
# one archive the image builder unpacks there.
for launcher in wldesktop desktops/hyprdesktop desktops/omarchydesktop \
                desktops/omarchy-theme-changed; do
    cp "$HERE/$launcher" "$WORK_DIR/$(basename "$launcher")"
    chmod 0755 "$WORK_DIR/$(basename "$launcher")"
done
# Deterministic: sorted entries, fixed timestamps and modes, so the archive's
# bytes depend only on its inputs. The font is the one libwpkdraw vendors.
python3 - "$HERE/desktops/data" "$SOURCE_ROOT/third_party/Inconsolata-Regular.ttf" \
    "$WORK_DIR/kandelo-desktop-data.zip" <<'PY'
import os, sys, zipfile
data, font, out = sys.argv[1:4]
entries = []
for root, _dirs, files in os.walk(data):
    for name in files:
        path = os.path.join(root, name)
        entries.append((os.path.relpath(path, data), path))
entries.append(("fonts/Inconsolata-Regular.ttf", font))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for arcname, path in sorted(entries):
        info = zipfile.ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(path, "rb") as f:
            z.writestr(info, f.read())
PY

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
for prog in wlcompositor wlterm wlclock wlpaint klauncher notify-send; do
    install_local_binary wayland-demo "$WORK_DIR/$prog.wasm" "$prog.wasm"
done
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    for launcher in wldesktop hyprdesktop omarchydesktop omarchy-theme-changed; do
        install -m 0755 "$WORK_DIR/$launcher" "$WASM_POSIX_DEP_OUT_DIR/$launcher"
    done
    install -m 0644 "$WORK_DIR/kandelo-desktop-data.zip" \
        "$WASM_POSIX_DEP_OUT_DIR/kandelo-desktop-data.zip"
fi
# The compositor links libinput statically, so the device quirks libinput
# reads at runtime travel with this package (see [[runtime_files]]).
install_local_runtime_file wayland-demo \
    "$LIBINPUT/share/libinput-quirks.zip" libinput-quirks.zip
