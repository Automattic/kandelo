#!/usr/bin/env bash
#
# Build the Wayland desktop: wlcompositor (server) plus the wlclock,
# wlpaint and wlterm clients, and stage the wldesktop launcher.
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
         examples/libs/wpkdraw/src/wpkdraw.c examples/libs/libkwl/src/kwl.c; do
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
        libwayland libxkbcommon libinput libevdev libudev mtdev libffi
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# libinput's public header and the wayland-protocols XML are read from their
# resolved prefixes directly; everything else is now inside $SYSROOT.
LIBINPUT="${WASM_POSIX_DEP_LIBINPUT_DIR:?resolve wayland-demo through cargo xtask build-deps}"
PROTOCOLS="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?missing wayland-protocols prefix}"

# --- Generate the xdg-shell protocol glue -----------------------------
GEN="$WORK_DIR/gen"
mkdir -p "$GEN"
XDG_XML="$PROTOCOLS/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml"
[ -f "$XDG_XML" ] || XDG_XML="$SOURCE_ROOT/packages/registry/wayland-protocols/xml/xdg-shell.xml"
echo "==> Generating xdg-shell glue from $XDG_XML..."
wayland-scanner private-code  "$XDG_XML" "$GEN/xdg-shell-protocol.c"
wayland-scanner server-header "$XDG_XML" "$GEN/xdg-shell-server-protocol.h"
wayland-scanner client-header "$XDG_XML" "$GEN/xdg-shell-client-protocol.h"

# --- In-tree libraries into the private sysroot -----------------------
LLVM_AR="$(command -v llvm-ar || command -v ar)"
CC_BIN="$(command -v wasm32posix-cc)"
echo "==> Building libwpkdraw..."
CC="$CC_BIN" AR="$LLVM_AR" bash "$SOURCE_ROOT/examples/libs/wpkdraw/build.sh" "$SYSROOT"
echo "==> Building libkwl..."
CC="$CC_BIN" AR="$LLVM_AR" XDG_SHELL_INCLUDE="$GEN" \
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

# --- launcher ---------------------------------------------------------
cp "$HERE/wldesktop" "$WORK_DIR/wldesktop"
chmod 0755 "$WORK_DIR/wldesktop"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
for prog in wlcompositor wlterm wlclock wlpaint; do
    install_local_binary wayland-demo "$WORK_DIR/$prog.wasm" "$prog.wasm"
done
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    install -m 0755 "$WORK_DIR/wldesktop" "$WASM_POSIX_DEP_OUT_DIR/wldesktop"
fi
