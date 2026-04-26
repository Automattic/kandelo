#!/usr/bin/env bash
# Cross-compile maximevince/fbDOOM for the wasm-posix-kernel using
# wasm32posix-cc. The fbdev frontend writes BGRA32 pixels into the
# framebuffer mmap; the canvas renderer (host/src/framebuffer/canvas-renderer.ts)
# consumes them.
#
# Output: examples/libs/fbdoom/fbdoom.wasm
#
# Usage: bash examples/libs/fbdoom/build-fbdoom.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/fbdoom-src"

if [ ! -d "$SRC" ]; then
    echo "==> Cloning maximevince/fbDOOM..."
    git clone --depth 1 https://github.com/maximevince/fbDOOM "$SRC"

    echo "==> Applying patches..."
    # Apply each numbered patch in order. Idempotent: only on fresh clone.
    for p in "$HERE/patches/"*.patch; do
        [ -f "$p" ] || continue
        echo "    $(basename "$p")"
        (cd "$SRC" && patch -p1 < "$p")
    done
fi

cd "$SRC/fbdoom"

echo "==> Cleaning previous build..."
make clean || true

echo "==> Cross-compiling fbdoom (wasm32, NOSDL=1)..."
# fbDOOM's own Makefile already wires NOSDL=1 to the framebuffer + null
# audio frontend; we just override the toolchain.
#
# LIBS="-lm" — wasm32posix-cc auto-injects channel_syscall.c plus the
# musl libc.a; passing -lc explicitly (the upstream Makefile default)
# would cause duplicate-symbol errors for fork / _Fork / __syscall_cp.
# We keep -lm because the SDK doesn't auto-link libm.
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE" \
     LDFLAGS="" \
     LIBS="-lm" \
     NOSDL=1

cp fbdoom "$HERE/fbdoom.wasm"

# fbDOOM doesn't fork — no asyncify / wasm-fork-instrument step needed.
# (vs other ports here: dash forks via popen/system, so its build-dash.sh
# runs `wasm-opt --asyncify` for the fork path.)

ls -la "$HERE/fbdoom.wasm"
echo "==> fbdoom.wasm built."

# ── DOOM IWAD ─────────────────────────────────────────────────────────────
# Fetch a freely-redistributable IWAD into the browser-demo asset slot.
#
# Freedoom Phase 1 (BSD-style licence) is a drop-in replacement for the
# DOOM shareware IWAD that maximevince/fbDOOM accepts unmodified. We
# pin a release tag + sha256 so the demo is reproducible.
#
# Skip the download if a WAD is already present — lets users substitute
# the original shareware doom1.wad if they prefer.

WAD_DEST="$REPO_ROOT/examples/browser/public/assets/doom/doom1.wad"
FREEDOOM_VERSION="0.13.0"
FREEDOOM_URL="https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/freedoom-${FREEDOOM_VERSION}.zip"
FREEDOOM_ZIP_SHA256="3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59"
FREEDOOM_WAD_SHA256="7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d"

mkdir -p "$(dirname "$WAD_DEST")"

if [ -f "$WAD_DEST" ]; then
    echo "==> WAD already present at $WAD_DEST — skipping fetch."
else
    echo "==> Fetching Freedoom Phase 1 v${FREEDOOM_VERSION} …"
    TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR"' EXIT
    ZIP="$TMPDIR/freedoom.zip"
    curl -fSL --retry 3 -o "$ZIP" "$FREEDOOM_URL"

    # Verify the zip checksum before extracting.
    GOT_ZIP_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
    if [ "$GOT_ZIP_SHA" != "$FREEDOOM_ZIP_SHA256" ]; then
        echo "ERROR: freedoom-${FREEDOOM_VERSION}.zip sha256 mismatch" >&2
        echo "  expected: $FREEDOOM_ZIP_SHA256" >&2
        echo "  got:      $GOT_ZIP_SHA" >&2
        exit 1
    fi

    unzip -p "$ZIP" "freedoom-${FREEDOOM_VERSION}/freedoom1.wad" > "$WAD_DEST"

    GOT_WAD_SHA="$(shasum -a 256 "$WAD_DEST" | awk '{print $1}')"
    if [ "$GOT_WAD_SHA" != "$FREEDOOM_WAD_SHA256" ]; then
        echo "ERROR: extracted freedoom1.wad sha256 mismatch" >&2
        echo "  expected: $FREEDOOM_WAD_SHA256" >&2
        echo "  got:      $GOT_WAD_SHA" >&2
        exit 1
    fi

    echo "==> Freedoom1 WAD installed at $WAD_DEST ($(wc -c < "$WAD_DEST") bytes)."
fi
