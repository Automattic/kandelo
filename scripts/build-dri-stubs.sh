#!/bin/bash
set -euo pipefail

# Install sysroot/lib/libdrm.a from the libdrm package and compile
# libc/glue/libgbm_stub.c into sysroot/lib/libgbm.a. Run after
# scripts/build-musl.sh has populated the sysroot with gbm.h from
# libc/musl-overlay/include/.
#
# libdrm is upstream 2.4.120, KMS subset only. The recipe lives at
# packages/registry/libdrm/; the dep-resolver compiles xf86drm.c /
# xf86drmMode.c / xf86drmHash.c / xf86drmRandom.c into libdrm.a and
# stages the UAPI + public headers under a cached prefix. We copy both
# into the sysroot so `-ldrm` resolves and the headers are visible at
# $SYSROOT/include/drm/ and $SYSROOT/include/libdrm/. Copy, not
# symlink: scripts/test-graphics-pkgconfig.sh proves a copied sysroot
# still resolves its graphics flags, and a link into the resolver
# cache would leave that copy dangling.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/libc/glue"

# shellcheck source=build-step-input-hash.sh
source "$REPO_ROOT/scripts/build-step-input-hash.sh"

# Auto-detect LLVM from the declared environment or ordinary PATH.
find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found. Set LLVM_BIN or install LLVM." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"
AR="$LLVM_BIN/llvm-ar"

if [ ! -f "$SYSROOT/include/gbm.h" ]; then
    echo "Error: gbm.h missing from $SYSROOT/include." >&2
    echo "Run scripts/build-musl.sh first (installs overlay headers)." >&2
    exit 1
fi

OUT_DIR="$SYSROOT/lib"
PC_DIR="$OUT_DIR/pkgconfig"
STAMP="$SYSROOT/.kandelo-dri-stubs.input-hash"

# A sysroot outlives the tree that produced it. `xtask bootstrap sysroot`
# only rebuilds musl when sysroot/lib/libc.a is missing, so a worktree
# provisioned before these sources changed keeps whatever libdrm.a /
# libgbm.a it was first given — and every program that links `-ldrm`
# or `-lgbm` afterwards silently picks up the older entry-point set.
# The SDK links executables with `-Wl,--allow-undefined` (autoconf link
# probes depend on it), so the missing entry points do not fail the link:
# they become `env.*` imports the host resolves to a throwing stub, and
# the program dies mid-run on the first call. That is how the shipped
# SDL2 demo ended up calling `env.drmAuthMagic`.
#
# Record the digest of the sources these archives are built from, so
# bootstrap can call this script on every sysroot resync and it costs
# nothing when the archives already match the tree.
ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
    "$REPO_ROOT/crates/shared/src/lib.rs")"
if [ -z "$ABI_VERSION" ]; then
    echo "Error: could not read ABI_VERSION from crates/shared/src/lib.rs" >&2
    exit 1
fi
DRI_INPUT_HASH="$(repo_input_hash "$REPO_ROOT" \
    scripts/build-dri-stubs.sh \
    scripts/write-graphics-pkgconfig.sh \
    scripts/build-step-input-hash.sh \
    packages/registry/libdrm \
    libc/glue \
    libc/musl-overlay/include \
    "literal:ABI_VERSION=$ABI_VERSION")"

if [ "${KANDELO_BOOTSTRAP_FORCE_REBUILD:-0}" != "1" ] &&
   [ -f "$OUT_DIR/libgbm.a" ] &&
   [ -d "$SYSROOT/include/drm" ] &&
   [ -d "$SYSROOT/include/libdrm" ] &&
   [ -f "$PC_DIR/libdrm.pc" ] &&
   [ -f "$PC_DIR/gbm.pc" ] &&
   build_step_is_current "$OUT_DIR/libdrm.a" "$STAMP" "$DRI_INPUT_HASH"; then
    echo "==> sysroot DRI libraries up to date ($DRI_INPUT_HASH)"
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT_DIR" "$PC_DIR"

echo "Resolving libdrm (upstream KMS subset)..."
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libdrm >/dev/null)
LIBDRM_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libdrm)"
if [ ! -f "$LIBDRM_PREFIX/lib/libdrm.a" ]; then
    echo "Error: libdrm resolve succeeded but $LIBDRM_PREFIX/lib/libdrm.a is missing." >&2
    exit 1
fi
rm -rf "$OUT_DIR/libdrm.a" "$SYSROOT/include/drm" "$SYSROOT/include/libdrm"
cp "$LIBDRM_PREFIX/lib/libdrm.a" "$OUT_DIR/libdrm.a"
cp -R "$LIBDRM_PREFIX/include/drm"    "$SYSROOT/include/drm"
cp -R "$LIBDRM_PREFIX/include/libdrm" "$SYSROOT/include/libdrm"

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -I"$GLUE_DIR"
    -I"$SYSROOT/include/libdrm"
    -I"$SYSROOT/include/drm"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
)

echo "Building libgbm.a (libgbm_stub.c)..."
"$CC" "${CFLAGS[@]}" -c "$GLUE_DIR/libgbm_stub.c" -o "$TMP/libgbm_stub.o"
"$AR" rcs "$OUT_DIR/libgbm.a" "$TMP/libgbm_stub.o"

echo "DRI libraries installed:"
ls -la "$OUT_DIR/libdrm.a" "$OUT_DIR/libgbm.a"

bash "$REPO_ROOT/scripts/write-graphics-pkgconfig.sh" dri "$PC_DIR"

write_build_stamp "$STAMP" "$DRI_INPUT_HASH"
