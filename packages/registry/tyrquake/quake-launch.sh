#!/bin/sh
# Launch wrapper for the Quake software demo.
#
# Kandelo never ships a standalone pak0.pak. Instead the demo fetches id's
# original, intact shareware archive (quake106.zip) and this wrapper extracts
# id1/pak0.pak from it, on the user's own machine, with real tools:
#
#   quake106.zip --(unzip)--> resource.1 --(lha, lh5)--> ID1/PAK0.PAK
#
# The step is idempotent: it runs only when the pak is missing but the archive
# is present, so re-launches (and bring-your-own-pak) skip it. Any failure is
# surfaced honestly; the engine then reports its own "not found" error rather
# than pretending to have data.

set -e

BASE=/usr/share/quake
PAK="$BASE/id1/pak0.pak"
ZIP="$BASE/quake106.zip"

if [ ! -f "$PAK" ] && [ -f "$ZIP" ]; then
    echo "quake: extracting shareware data from quake106.zip..." >&2
    mkdir -p "$BASE/id1"
    cd "$BASE"
    # 1. Unpack the shareware archive; yields resource.1 (an LZH lh5 archive).
    unzip -o "$ZIP" >/dev/null
    # 2. lh5-extract resource.1; yields ID1/PAK0.PAK (upper-case, DOS layout).
    lha xf resource.1 >/dev/null 2>&1 || true
    # 3. Normalise to the case-sensitive path the engine loads.
    src="$(find "$BASE" -iname 'pak0.pak' 2>/dev/null | head -n1)"
    if [ -n "$src" ] && [ "$src" != "$PAK" ]; then
        cp "$src" "$PAK"
    fi
    if [ -f "$PAK" ]; then
        echo "quake: extracted id1/pak0.pak" >&2
    else
        echo "quake: extraction failed; no pak0.pak produced" >&2
    fi
fi

exec /usr/local/bin/quake-engine -basedir "$BASE" "$@"
