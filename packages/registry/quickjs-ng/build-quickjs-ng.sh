#!/usr/bin/env bash
#
# Build QuickJS-NG (libqjs.a) for wasm32-posix-kernel.
#
# The engine is four translation units with no configure step, so they are
# compiled directly with the flags upstream's CMakeLists.txt uses for the
# `qjs` library target (-D_GNU_SOURCE, -funsigned-char). No source patches:
# QuickJS-NG selects its allocator-introspection and threading paths from
# generic feature tests, and on Kandelo it takes the plain POSIX branches
# (pthreads, C11 atomics, no malloc_usable_size).
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# the resolver sets WASM_POSIX_DEP_OUT_DIR / _WORK_DIR / _VERSION /
# _SOURCE_URL / _SOURCE_SHA256 / _SOURCE_DIR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/quickjs-ng-src"
BUILD_DIR="$WORK_DIR/quickjs-ng-build"
SOURCE_MARKER="$WORK_DIR/.kandelo-quickjs-ng-source"

QUICKJS_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/quickjs-ng-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

for tool in wasm32posix-cc wasm32posix-ar; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found after sourcing sdk/activate.sh." >&2
        exit 1
    fi
done

# --- Stage verified source ---------------------------------------------
# A tree staged for a different version, URL or hash is discarded rather
# than reused, so a version bump can never build the previous release.
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$QUICKJS_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified QuickJS-NG $QUICKJS_VERSION source..."
    kandelo_package_stage_verified_source quickjs-ng "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

# The pkg-config version must describe the source actually compiled, not the
# version the recipe asked for.
HEADER_VERSION="$(sed -n \
    -e 's/^#define QJS_VERSION_MAJOR \([0-9]*\)$/\1/p' \
    -e 's/^#define QJS_VERSION_MINOR \([0-9]*\)$/\1/p' \
    -e 's/^#define QJS_VERSION_PATCH \([0-9]*\)$/\1/p' \
    "$SRC_DIR/quickjs.h" | paste -sd. -)"
if [ "$HEADER_VERSION" != "$QUICKJS_VERSION" ]; then
    echo "ERROR: quickjs.h reports version '$HEADER_VERSION', recipe expects $QUICKJS_VERSION" >&2
    exit 1
fi

# Fresh objects and a fresh install on every run. The output prefix is
# emptied rather than replaced: the resolver records its inode identity.
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete
mkdir -p "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include/quickjs-ng"

# --- Compile ------------------------------------------------------------
# Mirrors CMakeLists.txt: qjs_sources, the _GNU_SOURCE define and
# -funsigned-char (libregexp and libunicode index tables by `char`).
CFLAGS=(
    -O2 -std=gnu11 -D_GNU_SOURCE -funsigned-char
    -Wall -Wno-implicit-fallthrough -Wno-sign-compare
    -Wno-missing-field-initializers -Wno-unused-parameter
    -Wno-unused-but-set-variable -Wno-unused-result -Wno-array-bounds
)
TUS=(dtoa.c libregexp.c libunicode.c quickjs.c)

echo "==> Compiling ${#TUS[@]} QuickJS-NG translation units for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    obj="$BUILD_DIR/${tu%.c}.o"
    wasm32posix-cc -c "${CFLAGS[@]}" "$SRC_DIR/$tu" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Archiving libqjs.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libqjs.a" "${OBJS[@]}"

# --- Install ------------------------------------------------------------
# Upstream's meson install puts the header under include/quickjs-ng and the
# pkg-config file adds that directory, so consumers write <quickjs.h>.
cp "$SRC_DIR/quickjs.h" "$INSTALL_DIR/include/quickjs-ng/quickjs.h"

cat > "$INSTALL_DIR/lib/pkgconfig/quickjs-ng.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: quickjs-ng
Description: QuickJS, the Next Generation: a mighty JavaScript engine
URL: https://github.com/quickjs-ng/quickjs
Version: $QUICKJS_VERSION
Libs: -L\${libdir} -lqjs
Libs.private: -lm -lpthread
Cflags: -I\${includedir}/quickjs-ng
PCEOF

echo "==> QuickJS-NG $QUICKJS_VERSION installed at $INSTALL_DIR"
ls -lh "$INSTALL_DIR/lib/libqjs.a"
