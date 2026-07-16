#!/usr/bin/env bash
# Cross-compile maximevince/fbDOOM for Kandelo using
# wasm32posix-cc. The fbdev frontend writes BGRA32 pixels into the
# framebuffer mmap; the canvas renderer (host/src/framebuffer/canvas-renderer.ts)
# consumes them.
#
# Output: packages/registry/fbdoom/fbdoom.wasm
#
# Usage: bash packages/registry/fbdoom/build-fbdoom.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
UPSTREAM_SRC="$HERE/fbdoom-src"
SRC="$HERE/fbdoom-build"
CDOOM_SRC="$HERE/chocolate-doom-src"

# Pin the upstream tree that the patch series targets. fbDOOM has no release
# tags, so building whatever happens to be at the remote default branch would
# make a package revision non-reproducible.
FBDOOM_COMMIT="17280163bc95e5d954d2efaa0633489b763b4cd1"

# Pin to chocolate-doom 3.1.0. fbDOOM stripped its OPL/MIDI/MUS sources
# when removing SDL; we vendor them back so the music path compiles.
CDOOM_COMMIT="35fb1372d10756ca27eca05665bd8a7cebc71c05" # chocolate-doom-3.1.0

# Use this worktree's SDK and sysroot rather than the global `npm link`
# (which may point at a sibling worktree without our linux/fb.h overlay).
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

if [ ! -d "$UPSTREAM_SRC/.git" ]; then
    if [ -e "$UPSTREAM_SRC" ]; then
        echo "ERROR: $UPSTREAM_SRC exists but is not a git checkout" >&2
        exit 1
    fi
    echo "==> Cloning maximevince/fbDOOM source cache..."
    git clone --filter=blob:none --no-checkout \
        https://github.com/maximevince/fbDOOM "$UPSTREAM_SRC"
fi

if ! git -C "$UPSTREAM_SRC" cat-file -e "$FBDOOM_COMMIT^{commit}" 2>/dev/null; then
    echo "==> Fetching pinned fbDOOM commit $FBDOOM_COMMIT..."
    git -C "$UPSTREAM_SRC" fetch --depth 1 origin "$FBDOOM_COMMIT"
fi

apply_patches() {
    echo "==> Applying patches..."
    for p in "$HERE/patches/"*.patch; do
        [ -f "$p" ] || continue
        name="$(basename "$p")"
        if ! (cd "$SRC" && git --git-dir="$UPSTREAM_SRC/.git" \
            --work-tree="$SRC" apply --check "$p"); then
            echo "ERROR: patch $name does not apply cleanly" >&2
            exit 1
        fi
        echo "    $name"
        (cd "$SRC" && git --git-dir="$UPSTREAM_SRC/.git" \
            --work-tree="$SRC" apply "$p")
    done
}

if [ ! -d "$CDOOM_SRC/.git" ]; then
    if [ -e "$CDOOM_SRC" ]; then
        echo "ERROR: $CDOOM_SRC exists but is not a git checkout" >&2
        exit 1
    fi
    echo "==> Cloning chocolate-doom @ $CDOOM_COMMIT for music sources..."
    git clone --filter=blob:none --no-checkout \
        https://github.com/chocolate-doom/chocolate-doom "$CDOOM_SRC"
fi
if ! git -C "$CDOOM_SRC" cat-file -e "$CDOOM_COMMIT^{commit}" 2>/dev/null; then
    echo "==> Fetching pinned chocolate-doom commit $CDOOM_COMMIT..."
    git -C "$CDOOM_SRC" fetch --depth 1 origin "$CDOOM_COMMIT"
fi

# Always construct the patched source from the pinned commit. The upstream
# checkout is only a content cache, so local edits there are neither destroyed
# nor accidentally incorporated into a package artifact.
echo "==> Creating pristine fbDOOM build tree..."
rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$UPSTREAM_SRC" archive "$FBDOOM_COMMIT" | tar -x -C "$SRC"

echo "==> Vendoring OPL/MIDI/MUS sources from chocolate-doom..."
VENDOR_SRC="$SRC/.chocolate-doom"
mkdir -p "$VENDOR_SRC"
git -C "$CDOOM_SRC" archive "$CDOOM_COMMIT" -- \
    opl/opl.c opl/opl.h opl/opl3.c opl/opl3.h opl/opl_internal.h \
    opl/opl_queue.c opl/opl_queue.h \
    src/mus2mid.c src/mus2mid.h src/midifile.c src/midifile.h \
    | tar -x -C "$VENDOR_SRC"
mkdir -p "$SRC/fbdoom/opl"
for f in opl.c opl.h opl3.c opl3.h opl_internal.h opl_queue.c opl_queue.h; do
    cp "$VENDOR_SRC/opl/$f" "$SRC/fbdoom/opl/$f"
done
for f in mus2mid.c mus2mid.h midifile.c midifile.h; do
    cp "$VENDOR_SRC/src/$f" "$SRC/fbdoom/$f"
done
rm -rf "$VENDOR_SRC"

apply_patches

cd "$SRC/fbdoom"

echo "==> Cleaning previous build..."
make clean || true

echo "==> Cross-compiling fbdoom (wasm32, NOSDL=1)..."
# fbDOOM's own Makefile wires NOSDL=1 to the framebuffer frontend; the
# patch series adds a conventional OSS PCM module alongside it. We only
# override the toolchain here.
#
# LIBS="-lm" — wasm32posix-cc auto-injects channel_syscall.c plus the
# musl libc.a; passing -lc explicitly (the upstream Makefile default)
# would cause duplicate-symbol errors for fork / _Fork / __syscall_cp.
# We keep -lm because the SDK doesn't auto-link libm.
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -Iopl" \
     LDFLAGS="" \
     LIBS="-lm" \
     NOSDL=1

cp fbdoom "$HERE/fbdoom.wasm"

# fbDOOM doesn't fork — no wasm-fork-instrument step needed.
# (vs other ports here: dash forks via popen/system, so its build-dash.sh
# runs `wasm-fork-instrument` for the fork path.)

ls -la "$HERE/fbdoom.wasm"
echo "==> fbdoom.wasm built."

# Install into local-binaries/ (resolver priority 1) and the resolver
# scratch dir when invoked by xtask build-deps / archive-stage.
#
# Return to the repository before invoking its artifact installer.
#
# No IWAD is bundled. The browser demo fetches the DOOM shareware
# `doom1.wad` at page load (id Software, freely redistributable) and
# caches it via the Cache API — see apps/browser-demos/pages/doom/main.ts.
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary fbdoom "$HERE/fbdoom.wasm" fbdoom.wasm
