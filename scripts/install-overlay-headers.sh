#!/bin/bash
set -euo pipefail

# Copy headers from musl-overlay/include/ into a sysroot's include/ tree.
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
OVERLAY_DIR="$REPO_ROOT/musl-overlay"

if [ ! -d "$SYSROOT" ]; then
    # Nothing to install into — caller should have built the sysroot first.
    exit 0
fi

if [ ! -d "$OVERLAY_DIR/include" ]; then
    exit 0
fi

cd "$OVERLAY_DIR/include"
find . -name '*.h' | while read -r f; do
    mkdir -p "$SYSROOT/include/$(dirname "$f")"
    cp "$f" "$SYSROOT/include/$f"
done
