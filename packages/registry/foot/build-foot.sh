#!/usr/bin/env bash
#
# Build foot (foot.wasm) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). foot is meson-only upstream, so we
# bypass it like fcft: run the two upstream generators (version.h and
# the builtin terminfo header, both plain python/sh — no tic), generate
# the client glue for the eleven protocol XMLs with wayland-scanner,
# and compile the meson TU list directly.
#
# One patch: shm.c allocates wl_shm pools as renderD128 dumb-bos passed
# by prime-fd instead of memfds — on this kernel a memfd MAP_SHARED
# mapping only writes back on msync/munmap, so the compositor would
# composite stale bytes. The bo path is the same shared-buffer contract
# every in-tree client uses (see wlcompositor.c "wl_shm pool / buffer").
#
# foot forks its shell (slave.c) — wasm-fork-instrument is mandatory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/foot-src"

FOOT_VERSION="${WASM_POSIX_DEP_VERSION:-1.17.2}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/foot-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://codeberg.org/dnkl/foot/releases/download/${FOOT_VERSION}/foot-${FOOT_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/foot-build"

for tool in wasm32posix-cc python3 wayland-scanner; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

FCFT_PREFIX="${WASM_POSIX_DEP_FCFT_DIR:?WASM_POSIX_DEP_FCFT_DIR not set (must be invoked via cargo xtask build-deps resolve foot)}"
FONTCONFIG_PREFIX="${WASM_POSIX_DEP_FONTCONFIG_DIR:?WASM_POSIX_DEP_FONTCONFIG_DIR not set}"
FREETYPE_PREFIX="${WASM_POSIX_DEP_FREETYPE_DIR:?WASM_POSIX_DEP_FREETYPE_DIR not set}"
PIXMAN_PREFIX="${WASM_POSIX_DEP_PIXMAN_DIR:?WASM_POSIX_DEP_PIXMAN_DIR not set}"
TLLIST_PREFIX="${WASM_POSIX_DEP_TLLIST_DIR:?WASM_POSIX_DEP_TLLIST_DIR not set}"
UTF8PROC_PREFIX="${WASM_POSIX_DEP_UTF8PROC_DIR:?WASM_POSIX_DEP_UTF8PROC_DIR not set}"
LIBWAYLAND_PREFIX="${WASM_POSIX_DEP_LIBWAYLAND_DIR:?WASM_POSIX_DEP_LIBWAYLAND_DIR not set}"
LIBXKBCOMMON_PREFIX="${WASM_POSIX_DEP_LIBXKBCOMMON_DIR:?WASM_POSIX_DEP_LIBXKBCOMMON_DIR not set}"
LIBFFI_PREFIX="${WASM_POSIX_DEP_LIBFFI_DIR:?WASM_POSIX_DEP_LIBFFI_DIR not set}"
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?WASM_POSIX_DEP_LIBXML2_DIR not set}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?WASM_POSIX_DEP_ZLIB_DIR not set}"
PROTOCOLS_XML="${WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR:?WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR not set}/xml"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# --- Fetch + verify + patch source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading foot $FOOT_VERSION..."
    TARBALL="/tmp/foot-${FOOT_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    echo "==> Applying patches..."
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        patch -p1 -d "$SRC_DIR" < "$p"
    done
fi

rm -rf "$BUILD_DIR" "$INSTALL_DIR"
GEN="$BUILD_DIR/gen"
mkdir -p "$GEN" "$INSTALL_DIR"

echo "==> Generating version.h + builtin terminfo + protocol glue..."
LC_ALL=C sh "$SRC_DIR/generate-version.sh" "$FOOT_VERSION" "$SRC_DIR" "$GEN/version.h"
python3 "$SRC_DIR/scripts/generate-builtin-terminfo.py" \
    '@default_terminfo@' "$SRC_DIR/foot.info" foot "$GEN/foot-terminfo.h"

PROTOCOLS=(
    xdg-shell
    xdg-decoration-unstable-v1
    xdg-output-unstable-v1
    primary-selection-unstable-v1
    presentation-time
    text-input-unstable-v3
    xdg-activation-v1
    viewporter
    fractional-scale-v1
    tablet-unstable-v2
    cursor-shape-v1
)
PROTO_OBJS=()
for proto in "${PROTOCOLS[@]}"; do
    wayland-scanner client-header "$PROTOCOLS_XML/$proto.xml" "$GEN/$proto.h"
    wayland-scanner private-code  "$PROTOCOLS_XML/$proto.xml" "$GEN/$proto.c"
done

CFLAGS=(
    -O2 -std=c11
    -D_GNU_SOURCE=200809L
    '-DFOOT_DEFAULT_TERM="foot"'
    -DFOOT_IME_ENABLED=1
    -DFOOT_GRAPHEME_CLUSTERING=1
    "-I$SRC_DIR"
    "-I$GEN"
    "-I$FCFT_PREFIX/include"
    "-I$FONTCONFIG_PREFIX/include"
    "-I$PIXMAN_PREFIX/include/pixman-1"
    "-I$TLLIST_PREFIX/include"
    "-I$UTF8PROC_PREFIX/include"
    "-I$LIBWAYLAND_PREFIX/include"
    "-I$LIBXKBCOMMON_PREFIX/include"
    -Wno-unused-variable -Wno-unused-function -Wno-unused-but-set-variable
)

TUS=(
    log.c char32.c debug.c xmalloc.c xsnprintf.c
    hsl.c misc.c uri.c
    base64.c composed.c cursor-shape.c csi.c dcs.c osc.c sixel.c vt.c
    grid.c selection.c terminal.c
    async.c box-drawing.c config.c commands.c extract.c fdm.c ime.c
    input.c key-binding.c main.c notify.c quirks.c reaper.c render.c
    search.c server.c shm.c slave.c spawn.c tokenize.c unicode-mode.c
    url-mode.c user-notification.c wayland.c
)

echo "==> Compiling foot for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    obj="$BUILD_DIR/${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/$tu" -o "$obj"
    OBJS+=("$obj")
done
for proto in "${PROTOCOLS[@]}"; do
    obj="$BUILD_DIR/proto-$proto.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$GEN/$proto.c" -o "$obj"
    OBJS+=("$obj")
done

# Link order: dependents before dependencies, libffi last so
# wl_closure_invoke's ffi_call resolves (same rule as build-programs.sh's
# wlcompositor pass). libgbm comes from the base sysroot (build-musl.sh).
echo "==> Linking foot.wasm..."
wasm32posix-cc "${OBJS[@]}" \
    -Wl,-z,stack-size=1048576 -Wl,--export=__abi_version \
    "$FCFT_PREFIX/lib/libfcft.a" \
    "$FONTCONFIG_PREFIX/lib/libfontconfig.a" \
    "$FREETYPE_PREFIX/lib/libfreetype.a" \
    "$LIBXML2_PREFIX/lib/libxml2.a" \
    "$ZLIB_PREFIX/lib/libz.a" \
    "$PIXMAN_PREFIX/lib/libpixman-1.a" \
    "$UTF8PROC_PREFIX/lib/libutf8proc.a" \
    "$LIBWAYLAND_PREFIX/lib/libwayland-cursor.a" \
    "$LIBWAYLAND_PREFIX/lib/libwayland-client.a" \
    "$LIBXKBCOMMON_PREFIX/lib/libxkbcommon.a" \
    "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a" \
    "$LIBFFI_PREFIX/lib/libffi.a" \
    -o "$BUILD_DIR/foot.wasm"

echo "==> Instrumenting fork paths..."
bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$BUILD_DIR/foot.wasm" -o "$BUILD_DIR/foot.wasm.instr"
mv "$BUILD_DIR/foot.wasm.instr" "$BUILD_DIR/foot.wasm"

cp "$BUILD_DIR/foot.wasm" "$INSTALL_DIR/foot.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary foot "$BUILD_DIR/foot.wasm"

echo "==> foot build complete!"
ls -lh "$INSTALL_DIR/foot.wasm"
