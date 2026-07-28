#!/bin/bash
set -euo pipefail

# Copy headers from libc/musl-overlay/include/ into a sysroot's include/ tree.
#
# This is the same install step that scripts/build-musl.sh performs at the
# end of a full musl build. It's split out so run.sh can re-run it
# unconditionally on every invocation — without it, adding a new overlay
# header (e.g. linux/fb.h) only propagates after `rm -rf sysroot && rebuild`,
# because has_sysroot() short-circuits on a stale libc.a.
#
# Usage:
#   scripts/install-overlay-headers.sh <sysroot-dir>

if [ $# -ne 1 ]; then
    echo "Usage: $0 <sysroot-dir>" >&2
    exit 1
fi

SYSROOT="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY_DIR="$REPO_ROOT/libc/musl-overlay"

if [ ! -d "$SYSROOT" ]; then
    # Nothing to install into — caller should have built the sysroot first.
    exit 0
fi

if [ ! -d "$OVERLAY_DIR/include" ]; then
    exit 0
fi

# WHY: `run.sh` invokes this incrementally, so copying alone would retain a
# generated header after its authoritative overlay is renamed or removed.
# Mirror only Kandelo's reserved bits-header namespace; unrelated musl and
# third-party headers in the caller-provided sysroot remain untouched.
if [ -d "$SYSROOT/include/bits" ]; then
    find "$SYSROOT/include/bits" -maxdepth 1 \
        \( -type f -o -type l \) -name 'kandelo_*.h' -delete
fi

cd "$OVERLAY_DIR/include"
find . -name '*.h' | while read -r f; do
    mkdir -p "$SYSROOT/include/$(dirname "$f")"
    cp "$f" "$SYSROOT/include/$f"
done
