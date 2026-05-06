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

# Use this worktree's SDK and sysroot rather than the global `npm link`
# (which may point at a sibling worktree without our linux/fb.h overlay).
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

if [ ! -d "$SRC" ]; then
    echo "==> Cloning maximevince/fbDOOM..."
    git clone --depth 1 https://github.com/maximevince/fbDOOM "$SRC"
fi

# Apply patches every build, skipping any that are already applied. The
# previous "patch only on fresh clone" gate silently produced a broken
# wasm whenever the source tree was reused — every required patch was
# missing, but `make` happily linked it and DOOM trapped at I_InitGraphics.
#
# We rely on `git apply --check` to distinguish "needs apply" from
# "already applied" — `patch --dry-run` prompts on stdin when it
# detects an already-applied hunk, which makes its exit code unreliable
# in non-interactive scripts. fbDOOM is cloned via `git clone` above,
# so the source tree is always a git repo here.
echo "==> Applying patches..."
for p in "$HERE/patches/"*.patch; do
    [ -f "$p" ] || continue
    name="$(basename "$p")"
    if (cd "$SRC" && git apply --check "$p") >/dev/null 2>&1; then
        echo "    $name"
        (cd "$SRC" && git apply "$p")
    elif (cd "$SRC" && git apply --reverse --check "$p") >/dev/null 2>&1; then
        echo "    $name (already applied)"
    else
        echo "ERROR: patch $name does not apply cleanly and is not already applied" >&2
        exit 1
    fi
done

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
# Fetch a freely-redistributable IWAD and stage it next to fbdoom.wasm.
#
# Freedoom Phase 1 (Modified BSD licence) is a drop-in replacement for the
# DOOM shareware IWAD that maximevince/fbDOOM accepts unmodified. The zip
# release URL and sha256 are pinned so the result is reproducible.
#
# We extract four files (filenames as they appear in the zip):
#   freedoom1.wad        → doom1.wad         (the IWAD itself)
#   COPYING.txt          → COPYING.txt       (Modified-BSD licence text)
#   CREDITS.txt          → CREDITS.txt       (asset / contributor attribution)
#   CREDITS-MUSIC.txt    → CREDITS-MUSIC.txt (music attribution: CC-BY entries)
#
# These ship inside the package's tar.zst archive (see package.toml's
# second [[outputs]]) so a cache-fetch user gets a complete bundle —
# the browser doom demo loads doom1.wad via a Vite ?url import off
# the `binaries/programs/wasm32/fbdoom/` symlinks placed by
# install_release. The licence files travel with it for compliance.

FREEDOOM_VERSION="0.13.0"
FREEDOOM_URL="https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/freedoom-${FREEDOOM_VERSION}.zip"
FREEDOOM_ZIP_SHA256="3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59"
FREEDOOM_WAD_SHA256="7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d"

WAD_DEST="$HERE/doom1.wad"
COPYING_DEST="$HERE/COPYING.txt"
CREDITS_DEST="$HERE/CREDITS.txt"
CREDITS_MUSIC_DEST="$HERE/CREDITS-MUSIC.txt"

if [ -f "$WAD_DEST" ] && [ -f "$COPYING_DEST" ] && [ -f "$CREDITS_DEST" ] && [ -f "$CREDITS_MUSIC_DEST" ]; then
    echo "==> Freedoom assets already present at $HERE — skipping fetch."
else
    echo "==> Fetching Freedoom Phase 1 v${FREEDOOM_VERSION} …"
    TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR"' EXIT
    ZIP="$TMPDIR/freedoom.zip"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL -o "$ZIP" "$FREEDOOM_URL"

    # Verify the zip checksum before extracting.
    GOT_ZIP_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
    if [ "$GOT_ZIP_SHA" != "$FREEDOOM_ZIP_SHA256" ]; then
        echo "ERROR: freedoom-${FREEDOOM_VERSION}.zip sha256 mismatch" >&2
        echo "  expected: $FREEDOOM_ZIP_SHA256" >&2
        echo "  got:      $GOT_ZIP_SHA" >&2
        exit 1
    fi

    unzip -p "$ZIP" "freedoom-${FREEDOOM_VERSION}/freedoom1.wad"     > "$WAD_DEST"
    unzip -p "$ZIP" "freedoom-${FREEDOOM_VERSION}/COPYING.txt"       > "$COPYING_DEST"
    unzip -p "$ZIP" "freedoom-${FREEDOOM_VERSION}/CREDITS.txt"       > "$CREDITS_DEST"
    unzip -p "$ZIP" "freedoom-${FREEDOOM_VERSION}/CREDITS-MUSIC.txt" > "$CREDITS_MUSIC_DEST"

    GOT_WAD_SHA="$(shasum -a 256 "$WAD_DEST" | awk '{print $1}')"
    if [ "$GOT_WAD_SHA" != "$FREEDOOM_WAD_SHA256" ]; then
        echo "ERROR: extracted freedoom1.wad sha256 mismatch" >&2
        echo "  expected: $FREEDOOM_WAD_SHA256" >&2
        echo "  got:      $GOT_WAD_SHA" >&2
        exit 1
    fi

    echo "==> Freedoom1 assets installed at $HERE ($(wc -c < "$WAD_DEST") bytes WAD)."
fi

# Install into local-binaries/ (resolver priority 1) and the resolver
# scratch dir when invoked by xtask build-deps / stage-release.
# fbdoom is now a multi-output package — pass the destination filename
# so install_local_binary uses the per-program subdir layout
# (local-binaries/programs/<arch>/fbdoom/<file>).
#
# `cd "$REPO_ROOT"` is load-bearing: install_local_binary uses
# `git rev-parse --show-toplevel` to locate the repo root, and we're
# still inside `$SRC/fbdoom` (a nested git clone) from the make step.
# Without the cd, git would return fbdoom's clone as the toplevel and
# we'd write into examples/libs/fbdoom/fbdoom-src/local-binaries/.
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary fbdoom "$HERE/fbdoom.wasm"   fbdoom.wasm
install_local_binary fbdoom "$WAD_DEST"           doom1.wad
install_local_binary fbdoom "$COPYING_DEST"       COPYING.txt
install_local_binary fbdoom "$CREDITS_DEST"       CREDITS.txt
install_local_binary fbdoom "$CREDITS_MUSIC_DEST" CREDITS-MUSIC.txt
