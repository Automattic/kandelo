#!/usr/bin/env bash
set -euo pipefail

# Build the canonical rootfs.vfs image from the top-level MANIFEST +
# images/rootfs/ source tree, using the mkrootfs CLI under tools/mkrootfs/.
# Output: host/wasm/rootfs.vfs (gitignored — built artifact).
#
# This is a Node.js/TypeScript invocation, not a wasm cross-compile,
# so it does not need scripts/dev-shell.sh — only `node` and `npx`
# from PATH (npx pulls tsx via the host package's devDeps).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# mkrootfs depends on the host package (file:../../host) for its VFS
# writer + fzstd; install both trees if missing.
if [ ! -d host/node_modules ]; then
    echo "==> Installing host/ dependencies (needed by mkrootfs)..."
    (cd host && npm ci --no-audit --no-fund --prefer-offline --silent)
fi
if [ ! -d tools/mkrootfs/node_modules ]; then
    echo "==> Installing tools/mkrootfs/ dependencies..."
    (cd tools/mkrootfs && npm ci --no-audit --no-fund --prefer-offline --silent)
fi

OUT="host/wasm/rootfs.vfs"
PKG_MANIFEST="target/rootfs-packages.MANIFEST"
ROOTFS_SAB_SIZE="${ROOTFS_SAB_SIZE:-16777216}"
ROOTFS_MAX_SIZE="${ROOTFS_MAX_SIZE:-268435456}"
ROOTFS_PACKAGES="images/rootfs/PACKAGES.toml"
mkdir -p "$(dirname "$OUT")"
ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' crates/shared/src/lib.rs)"
if [ -z "$ABI_VERSION" ]; then
    echo "ERROR: could not read ABI_VERSION from crates/shared/src/lib.rs" >&2
    exit 1
fi

if [ "${ROOTFS_SKIP_PACKAGE_RESOLVE:-0}" != "1" ]; then
    for tool in cargo rustc; do
        command -v "$tool" >/dev/null 2>&1 || {
            echo "build-rootfs: $tool not found on PATH" >&2
            exit 2
        }
    done
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    [ -n "$HOST_TARGET" ] || {
        echo "build-rootfs: rustc -vV did not report host triple" >&2
        exit 2
    }

    echo "==> Resolving rootfs packages from $ROOTFS_PACKAGES..."
    awk '
        /^\[\[packages\]\]/ { in_pkg = 1; next }
        /^\[/ { in_pkg = 0; next }
        in_pkg && /^name[[:space:]]*=/ {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)
            gsub(/["[:space:]]/, "", line)
            if (line != "" && !seen[line]++) print line
        }
    ' "$ROOTFS_PACKAGES" | while IFS= read -r pkg; do
        echo "  resolve $pkg (wasm32)"
        cargo run --release -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" \
            resolve "$pkg" >/dev/null
    done
else
    echo "==> Skipping package resolution (ROOTFS_SKIP_PACKAGE_RESOLVE=1)"
fi

echo "==> Generating rootfs package manifest from $ROOTFS_PACKAGES..."
node scripts/generate-rootfs-package-manifest.mjs --out "$PKG_MANIFEST"

echo "==> Building rootfs.vfs from MANIFEST + images/rootfs/ + packages..."
node tools/mkrootfs/bin/mkrootfs.mjs build MANIFEST images/rootfs \
    -o "$OUT" \
    --repo-root "$REPO_ROOT" \
    --manifest-fragment "$PKG_MANIFEST" \
    --sab-size "$ROOTFS_SAB_SIZE" \
    --max-size "$ROOTFS_MAX_SIZE" \
    --kernel-abi "$ABI_VERSION"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "==> Built $OUT ($SIZE bytes)"
