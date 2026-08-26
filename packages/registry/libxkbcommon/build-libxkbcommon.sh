#!/usr/bin/env bash
#
# Build libxkbcommon.a for wasm32-posix-kernel, pinned to libxkbcommon 1.7.0.
#
# We bypass upstream's meson build: it runs host-side feature probes that
# misreport against the wasm sysroot. Instead we mirror alsa-lib / libwayland
# — compile the core TUs directly with a hand-curated config.h (src/config.h)
# and a bison-generated xkbcomp parser. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR4).
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# when invoked via `cargo xtask build-deps resolve libxkbcommon` the resolver
# sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL / _SOURCE_SHA256.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/xkbcommon-src"

XKB_VERSION="${WASM_POSIX_DEP_VERSION:-1.7.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxkbcommon-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://xkbcommon.org/download/libxkbcommon-${XKB_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# --- Toolchain ----------------------------------------------------------
for tool in wasm32posix-cc wasm32posix-ar bison; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh (provides the" >&2
        echo "       wasm toolchain + bison from flake.nix)." >&2
        exit 1
    fi
done

# --- Fetch + verify source ---------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libxkbcommon $XKB_VERSION..."
    TARBALL="/tmp/libxkbcommon-${XKB_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
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

# Fresh build + install each run — stale objects would shadow config
# changes and the cache key varies per build.
BUILD_DIR="$SCRIPT_DIR/xkbcommon-build"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include/xkbcommon"

SRC="$SRC_DIR/src"

# --- config.h + bison-generated parser ---------------------------------
# Sources #include "config.h"; place it at the source root so -I"$SRC_DIR"
# resolves it for every TU (the quoted include falls through to the -I dir).
cp "$SCRIPT_DIR/src/config.h" "$SRC_DIR/config.h"

echo "==> Generating xkbcomp parser with $(bison --version | head -1)..."
# Mirrors meson's yacc_gen: prefix _xkbcommon_, emit parser.c + parser.h.
bison --defines="$SRC/xkbcomp/parser.h" -o "$SRC/xkbcomp/parser.c" \
    -p _xkbcommon_ "$SRC/xkbcomp/parser.y"

# --- Compile ------------------------------------------------------------
CFLAGS=(
    -O2 -fPIC -fvisibility=hidden -std=gnu11
    # (config.h #defines _GNU_SOURCE; sources include it first)
    "-I$SRC_DIR"          # config.h at source root
    "-I$SRC"              # internal headers (utils.h, xkbcomp/parser.h, ...)
    "-I$SRC_DIR/include"  # public xkbcommon/*.h
    -Wno-unused-parameter
    -Wno-unused-function
    -Wno-unused-variable
)

# TU paths are relative to src/; two subdirs each contribute a keymap.c /
# state.c / parser.c, so encode the subdir in the object name to avoid
# collisions in the flat build dir.
compile() {
    local tu="$1"
    local obj="$BUILD_DIR/$(echo "$tu" | sed 's#/#_#g; s#\.c$#.o#')"
    echo "    $tu" >&2
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC/$tu" -o "$obj"
    echo "$obj"
}

TUS=(
    atom.c context.c context-priv.c keysym.c keysym-utf.c
    keymap.c keymap-priv.c state.c text.c utf8.c utils.c
    compose/parser.c compose/paths.c compose/state.c compose/table.c
    xkbcomp/action.c xkbcomp/ast-build.c xkbcomp/compat.c xkbcomp/expr.c
    xkbcomp/include.c xkbcomp/keycodes.c xkbcomp/keymap.c xkbcomp/keymap-dump.c
    xkbcomp/keywords.c xkbcomp/parser.c xkbcomp/rules.c xkbcomp/scanner.c
    xkbcomp/symbols.c xkbcomp/types.c xkbcomp/vmod.c xkbcomp/xkbcomp.c
)

echo "==> Compiling ${#TUS[@]} TUs for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    OBJS+=("$(compile "$tu")")
done

echo "==> Archiving libxkbcommon.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libxkbcommon.a" "${OBJS[@]}"

# --- Install public headers --------------------------------------------
echo "==> Installing headers..."
for h in \
    xkbcommon.h xkbcommon-names.h xkbcommon-keysyms.h \
    xkbcommon-compat.h xkbcommon-compose.h
do
    cp "$SRC_DIR/include/xkbcommon/$h" "$INSTALL_DIR/include/xkbcommon/$h"
done

echo "==> libxkbcommon $XKB_VERSION installed at $INSTALL_DIR"
echo "    lib/libxkbcommon.a ($(wc -c < "$INSTALL_DIR/lib/libxkbcommon.a") bytes)"
