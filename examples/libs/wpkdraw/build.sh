#!/usr/bin/env bash
#
# Build libwpkdraw.a (CPU rasterizer + font engine) and install it into a
# wasm32 sysroot. wpkdraw is pure in-tree source with no upstream tarball
# and no CI-published binary, so it is NOT a `cargo xtask build-deps`
# package (the resolver only walks packages/registry/). Instead this
# standalone script is invoked directly by scripts/build-programs.sh, and
# can also be run by hand:
#
#     CC=/path/to/clang AR=/path/to/llvm-ar ./build.sh <sysroot>
#
# It installs:
#     <sysroot>/lib/libwpkdraw.a
#     <sysroot>/include/wpkdraw/{wpkdraw.h,wpkfont.h}
#
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${1:?usage: build.sh <sysroot>}"
CC="${CC:-clang}"
AR="${AR:-llvm-ar}"

WORK="$SRC_ROOT/build"
mkdir -p "$WORK"

# --- Embed the font: generate wpk_font_ttf.h from the vendored ttf. The
# .h is git-ignored; the .ttf is the source of truth (see NOTICE.md). Only
# regenerate when the ttf is newer, so repeat builds are cheap.
TTF="$SRC_ROOT/third_party/Inconsolata-Regular.ttf"
TTF_H="$SRC_ROOT/third_party/wpk_font_ttf.h"
if [ ! -f "$TTF_H" ] || [ "$TTF" -nt "$TTF_H" ]; then
    echo "  Regenerating wpk_font_ttf.h from $(basename "$TTF")..."
    python3 - "$TTF" "$TTF_H" <<'PY'
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
fi

# Compile flags for a wasm32 static archive. No link flags — these .o files
# archive into libwpkdraw.a and get linked into the consumer executable by
# build-programs.sh. -matomics/-mbulk-memory keep them ABI-compatible with
# the threaded final link.
CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -I"$SRC_ROOT/include"
    -I"$SRC_ROOT/third_party"
)

# stb_truetype implementation TU — exactly one place defines the impl.
cat > "$WORK/wpk_stb_impl.c" <<'EOF'
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"
EOF

echo "  Compiling libwpkdraw (wpkdraw.c, wpkfont.c, stb_truetype)..."
"$CC" "${CFLAGS[@]}" -c "$WORK/wpk_stb_impl.c"      -o "$WORK/wpk_stb_impl.o"
"$CC" "${CFLAGS[@]}" -c "$SRC_ROOT/src/wpkdraw.c"   -o "$WORK/wpkdraw.o"
"$CC" "${CFLAGS[@]}" -c "$SRC_ROOT/src/wpkfont.c"   -o "$WORK/wpkfont.o"

mkdir -p "$SYSROOT/lib" "$SYSROOT/include/wpkdraw"
"$AR" rcs "$SYSROOT/lib/libwpkdraw.a" \
    "$WORK/wpkdraw.o" "$WORK/wpkfont.o" "$WORK/wpk_stb_impl.o"
cp "$SRC_ROOT/include/wpkdraw/"*.h "$SYSROOT/include/wpkdraw/"

echo "  libwpkdraw installed: $SYSROOT/lib/libwpkdraw.a ($(wc -c < "$SYSROOT/lib/libwpkdraw.a") bytes)"
