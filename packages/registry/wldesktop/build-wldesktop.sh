#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"

SOURCES=(
    programs/wlcompositor/wlcompositor.c
    programs/wlterm/wlterm.c
    programs/wlterm/vt100.c
    programs/wlclock.c
    programs/wlpaint.c
    programs/klauncher.c
    programs/notify-send.c
    examples/libs/libkwl/src/kwl.c
    examples/libs/libkwl/include/kwl.h
    examples/libs/wpkdraw/src/wpkdraw.c
    examples/libs/wpkdraw/src/wpkfont.c
)
for f in "${SOURCES[@]}"; do
    if [ ! -f "$SOURCE_ROOT/$f" ] || [ -L "$SOURCE_ROOT/$f" ]; then
        echo "ERROR: wldesktop source must be a regular file: $SOURCE_ROOT/$f" >&2
        exit 1
    fi
done

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set (must be invoked via cargo xtask build-deps resolve wldesktop)}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set}"
LIBINPUT_PREFIX="${WASM_POSIX_DEP_LIBINPUT_DIR:?WASM_POSIX_DEP_LIBINPUT_DIR not set}"
LIBEVDEV_PREFIX="${WASM_POSIX_DEP_LIBEVDEV_DIR:?WASM_POSIX_DEP_LIBEVDEV_DIR not set}"
LIBUDEV_PREFIX="${WASM_POSIX_DEP_LIBUDEV_DIR:?WASM_POSIX_DEP_LIBUDEV_DIR not set}"
MTDEV_PREFIX="${WASM_POSIX_DEP_MTDEV_DIR:?WASM_POSIX_DEP_MTDEV_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
GLIB_PREFIX="${WASM_POSIX_DEP_GLIB_DIR:?WASM_POSIX_DEP_GLIB_DIR not set}"
PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:?WASM_POSIX_DEP_PCRE2_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
PROTOCOLS_XML="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR not set}/xml"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

if [ ! -f "$WASM_POSIX_SYSROOT/lib/libdrm.a" ] ||
   [ ! -f "$WASM_POSIX_SYSROOT/lib/libgbm.a" ] ||
   [ ! -f "$WASM_POSIX_SYSROOT/lib/libEGL.a" ] ||
   [ ! -f "$WASM_POSIX_SYSROOT/lib/libGLESv2.a" ]; then
    echo "ERROR: DRI/EGL/GLES sysroot libraries are missing." >&2
    echo "Run: scripts/dev-shell.sh bash scripts/build-musl.sh" >&2
    exit 1
fi

for tool in wasm32posix-cc wayland-scanner python3; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: $tool not found — run through scripts/dev-shell.sh" >&2
        exit 1
    }
done

# The generated header basenames are what the sources #include, so the stem
# is fixed by the consumer, not by the XML file name.
PROTOCOLS=(
    "xdg-shell:xdg-shell"
    "linux-dmabuf-v1:linux-dmabuf-v1"
    "xdg-decoration-v1:xdg-decoration-unstable-v1"
    "wlr-layer-shell-v1:wlr-layer-shell-unstable-v1"
    "presentation-time:presentation-time"
    "xdg-output-v1:xdg-output-unstable-v1"
    "viewporter:viewporter"
    "fractional-scale-v1:fractional-scale-v1"
)

GEN="$WORK_DIR/gen"
mkdir -p "$GEN"
echo "==> Generating the Wayland protocol glue..."
for entry in "${PROTOCOLS[@]}"; do
    stem="${entry%%:*}"
    xml="$PROTOCOLS_XML/${entry#*:}.xml"
    wayland-scanner private-code   "$xml" "$GEN/$stem-protocol.c"
    wayland-scanner server-header  "$xml" "$GEN/$stem-server-protocol.h"
    wayland-scanner client-header  "$xml" "$GEN/$stem-client-protocol.h"
done

# libwpkdraw and libkwl are in-tree source with no upstream tarball and no
# published binary, so the resolver never sees them. Their archives build
# into the work dir rather than through examples/libs/*/build.sh, which
# writes into the checkout this build must leave read-only.
WPKDRAW_DIR="$SOURCE_ROOT/examples/libs/wpkdraw"
LIBKWL_DIR="$SOURCE_ROOT/examples/libs/libkwl"
PREFIX="$WORK_DIR/prefix"
mkdir -p "$PREFIX/lib" "$PREFIX/include/wpkdraw"

echo "==> Generating wpk_font_ttf.h..."
python3 - "$WPKDRAW_DIR/third_party/Inconsolata-Regular.ttf" \
    "$WORK_DIR/wpk_font_ttf.h" <<'PY'
import sys, pathlib
src = pathlib.Path(sys.argv[1]).read_bytes()
lines = [",".join(f"0x{b:02x}" for b in src[i:i+16]) for i in range(0, len(src), 16)]
pathlib.Path(sys.argv[2]).write_text(
    "/* Auto-generated from Inconsolata-Regular.ttf — see NOTICE.md. */\n"
    "#pragma once\n"
    "static const unsigned char wpk_font_ttf[] = {\n"
    + ",\n".join(lines) + "\n};\n"
)
PY

ARCHIVE_CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$WASM_POSIX_SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
)

cat > "$WORK_DIR/wpk_stb_impl.c" <<'EOF'
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"
EOF

echo "==> Building libwpkdraw (CPU rasterizer)..."
for tu in "$WORK_DIR/wpk_stb_impl.c" "$WPKDRAW_DIR/src/wpkdraw.c" "$WPKDRAW_DIR/src/wpkfont.c"; do
    wasm32posix-cc "${ARCHIVE_CFLAGS[@]}" \
        -I"$WORK_DIR" \
        -I"$WPKDRAW_DIR/include" \
        -I"$WPKDRAW_DIR/third_party" \
        -c "$tu" -o "$WORK_DIR/$(basename "${tu%.c}").o"
done
wasm32posix-ar rcs "$PREFIX/lib/libwpkdraw.a" \
    "$WORK_DIR/wpkdraw.o" "$WORK_DIR/wpkfont.o" "$WORK_DIR/wpk_stb_impl.o"
cp "$WPKDRAW_DIR/include/wpkdraw/"*.h "$PREFIX/include/wpkdraw/"

echo "==> Building libkwl (Wayland toolkit)..."
wasm32posix-cc "${ARCHIVE_CFLAGS[@]}" \
    -I"$LIBKWL_DIR/include" \
    -I"$PREFIX/include" \
    -I"$LIBWAYLAND_PREFIX/include" \
    -I"$LIBXKBCOMMON_PREFIX/include" \
    -I"$GEN" \
    -c "$LIBKWL_DIR/src/kwl.c" -o "$WORK_DIR/kwl.o"
wasm32posix-ar rcs "$PREFIX/lib/libkwl.a" "$WORK_DIR/kwl.o"
cp "$LIBKWL_DIR/include/kwl.h" "$PREFIX/include/kwl.h"

DRI_CFLAGS="$(wasm32posix-pkg-config --cflags gbm libdrm egl glesv2)"
DRI_LIBS="$(wasm32posix-pkg-config --libs gbm libdrm egl glesv2)"

# Link order across every binary: dependents before dependencies, libffi
# last so wl_closure_invoke's ffi_call resolves.
KWL_PROTOCOL_SOURCES=(
    "$GEN/xdg-shell-protocol.c"
    "$GEN/xdg-decoration-v1-protocol.c"
    "$GEN/wlr-layer-shell-v1-protocol.c"
)
KWL_LIBS=(
    "$PREFIX/lib/libkwl.a"
    "$PREFIX/lib/libwpkdraw.a"
    "$LIBWAYLAND_PREFIX/lib/libwayland-client.a"
    "$LIBXKBCOMMON_PREFIX/lib/libxkbcommon.a"
    "$LIBFFI_PREFIX/lib/libffi.a"
)

echo "==> Building wlcompositor (Wayland server)..."
wasm32posix-cc \
    -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -D_DEFAULT_SOURCE \
    -I"$GEN" \
    -I"$LIBWAYLAND_PREFIX/include" \
    -I"$LIBXKBCOMMON_PREFIX/include" \
    -I"$LIBINPUT_PREFIX/include" \
    -I"$LIBUDEV_PREFIX/include" \
    -I"$PREFIX/include" \
    $DRI_CFLAGS \
    "$SOURCE_ROOT/programs/wlcompositor/wlcompositor.c" \
    "$GEN/xdg-shell-protocol.c" \
    "$GEN/linux-dmabuf-v1-protocol.c" \
    "$GEN/xdg-decoration-v1-protocol.c" \
    "$GEN/wlr-layer-shell-v1-protocol.c" \
    "$GEN/presentation-time-protocol.c" \
    "$GEN/xdg-output-v1-protocol.c" \
    "$GEN/viewporter-protocol.c" \
    "$GEN/fractional-scale-v1-protocol.c" \
    "$LIBWAYLAND_PREFIX/lib/libwayland-server.a" \
    "$PREFIX/lib/libwpkdraw.a" \
    "$LIBXKBCOMMON_PREFIX/lib/libxkbcommon.a" \
    "$LIBINPUT_PREFIX/lib/libinput.a" \
    "$LIBEVDEV_PREFIX/lib/libevdev.a" \
    "$LIBUDEV_PREFIX/lib/libudev.a" \
    "$MTDEV_PREFIX/lib/libmtdev.a" \
    "$LIBFFI_PREFIX/lib/libffi.a" \
    $DRI_LIBS \
    -lm \
    -o "$WORK_DIR/wlcompositor.wasm"

echo "==> Building wlterm (libkwl terminal + VT100 + forkpty)..."
wasm32posix-cc \
    -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -D_DEFAULT_SOURCE \
    -I"$GEN" -I"$PREFIX/include" \
    -I"$LIBWAYLAND_PREFIX/include" \
    -I"$LIBXKBCOMMON_PREFIX/include" \
    $DRI_CFLAGS \
    "$SOURCE_ROOT/programs/wlterm/wlterm.c" \
    "$SOURCE_ROOT/programs/wlterm/vt100.c" \
    "${KWL_PROTOCOL_SOURCES[@]}" \
    "${KWL_LIBS[@]}" \
    $DRI_LIBS \
    -lm \
    -o "$WORK_DIR/wlterm.wasm"

for app in wlclock wlpaint klauncher; do
    echo "==> Building $app (libkwl client)..."
    wasm32posix-cc \
        -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -D_DEFAULT_SOURCE \
        -I"$GEN" -I"$PREFIX/include" \
        -I"$LIBWAYLAND_PREFIX/include" \
        -I"$LIBXKBCOMMON_PREFIX/include" \
        $DRI_CFLAGS \
        "$SOURCE_ROOT/programs/$app.c" \
        "${KWL_PROTOCOL_SOURCES[@]}" \
        "${KWL_LIBS[@]}" \
        $DRI_LIBS \
        -lm \
        -o "$WORK_DIR/$app.wasm"
done

echo "==> Building notify-send (org.freedesktop.Notifications client)..."
wasm32posix-cc \
    -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -D_DEFAULT_SOURCE \
    -I"$GLIB_PREFIX/include/glib-2.0" \
    "$SOURCE_ROOT/programs/notify-send.c" \
    "$GLIB_PREFIX/lib/libgio-2.0.a" \
    "$GLIB_PREFIX/lib/libgobject-2.0.a" \
    "$GLIB_PREFIX/lib/libgmodule-2.0.a" \
    "$GLIB_PREFIX/lib/libglib-2.0.a" \
    "$PCRE2_PREFIX/lib/libpcre2-8.a" \
    "$LIBFFI_PREFIX/lib/libffi.a" \
    "$ZLIB_PREFIX/lib/libz.a" \
    -lm \
    -o "$WORK_DIR/notify-send.wasm"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
for out in wlcompositor wlterm wlclock wlpaint klauncher notify-send; do
    install_local_binary wldesktop "$WORK_DIR/$out.wasm" "$out.wasm"
done
