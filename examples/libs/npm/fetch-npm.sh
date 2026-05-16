#!/usr/bin/env bash
# Fetch a pinned npm release tarball from registry.npmjs.org, verify its
# sha256, and unpack it into examples/libs/npm/dist/. The unpacked tree is
# what later phases bundle into the kernel VFS image so user programs can
# `require('/usr/lib/npm/lib/cli.js')` and run `npm install` from inside
# node.wasm.
#
# Phase 5 — npm bootstrap. See docs/plans/2026-04-28-quickjs-node-compat-plan.md.
#
# To bump npm: change NPM_VERSION + NPM_SHA256 below. The sha is the
# sha256 of the raw .tgz served by registry.npmjs.org. Verify with:
#     curl -fsSL https://registry.npmjs.org/npm/-/npm-<v>.tgz | shasum -a 256
#
# The npm registry's own integrity field is sha512 (base64). We use sha256
# here because shasum -a 256 is universal across macOS/Linux build hosts.
#
# The dist/ tree and the .tgz cache are gitignored — fetched on demand.
set -euo pipefail

NPM_VERSION="10.9.2"
NPM_SHA256="5cd1e5ab971ea6333f910bc2d50700167c5ef4e66da279b2a3efc874c6b116e4"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
DIST_DIR="$SCRIPT_DIR/dist"
TARBALL="$CACHE_DIR/npm-$NPM_VERSION.tgz"
URL="https://registry.npmjs.org/npm/-/npm-$NPM_VERSION.tgz"

mkdir -p "$CACHE_DIR"

# Download (skip if already cached and valid).
need_fetch=1
if [ -f "$TARBALL" ]; then
    actual=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
    if [ "$actual" = "$NPM_SHA256" ]; then
        need_fetch=0
        echo "==> Cached tarball is valid: $TARBALL"
    else
        echo "==> Cached tarball has wrong sha256, re-fetching"
        rm -f "$TARBALL"
    fi
fi

if [ "$need_fetch" -eq 1 ]; then
    echo "==> Fetching $URL"
    curl -fsSL --max-time 120 -o "$TARBALL.tmp" "$URL"
    actual=$(shasum -a 256 "$TARBALL.tmp" | awk '{print $1}')
    if [ "$actual" != "$NPM_SHA256" ]; then
        echo "ERROR: sha256 mismatch" >&2
        echo "  expected: $NPM_SHA256" >&2
        echo "  actual:   $actual" >&2
        rm -f "$TARBALL.tmp"
        exit 1
    fi
    mv "$TARBALL.tmp" "$TARBALL"
    echo "==> Verified $TARBALL ($(wc -c < "$TARBALL") bytes)"
fi

# Unpack into a fresh dist/ tree. --strip-components=1 drops the leading
# "package/" directory the npm registry prepends to its tarballs.
echo "==> Unpacking to $DIST_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
tar -xzf "$TARBALL" -C "$DIST_DIR" --strip-components=1

# Sanity checks.
if [ ! -f "$DIST_DIR/bin/npm-cli.js" ]; then
    echo "ERROR: npm-cli.js missing after unpack" >&2
    exit 1
fi
if [ ! -f "$DIST_DIR/lib/cli.js" ]; then
    echo "ERROR: lib/cli.js missing after unpack" >&2
    exit 1
fi
ver=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$DIST_DIR/package.json")
if [ "$ver" != "$NPM_VERSION" ]; then
    echo "ERROR: package.json version $ver != pinned $NPM_VERSION" >&2
    exit 1
fi

count=$(find "$DIST_DIR" -type f | wc -l | tr -d ' ')
size=$(du -sh "$DIST_DIR" | cut -f1)
echo "==> Unpacked npm $NPM_VERSION ($count files, $size)"
echo "    Entry: $DIST_DIR/bin/npm-cli.js"
