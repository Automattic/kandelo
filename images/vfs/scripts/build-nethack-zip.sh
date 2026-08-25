#!/usr/bin/env bash
#
# Build nethack.zip for the browser shell demo.
#
# Packages nethack.wasm plus the runtime tree (nhdat, symbols, license)
# into a single zip archive. The shell VFS image registers this as a
# lazy archive with mount prefix /usr/, so entries become /usr/bin/nethack
# and /usr/share/nethack/…. On first exec of nethack, the whole archive
# is fetched and unpacked in one go.
#
# With `<dependency-dir> <output.zip>`, consumes only that exact declared
# dependency and writes only the selected output. With no arguments, retains
# the standalone developer mode: resolve NetHack, write the browser public
# asset, and install the result into the ordinary local mirror.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

INSTALL_LOCAL_MIRROR=0
case "$#" in
    0)
        OUTPUT_FILE="$REPO_ROOT/apps/browser-demos/public/nethack.zip"
        # Standalone developer mode resolves the package on demand. Canonical
        # package builds pass their direct dependency explicitly instead.
        HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
        NETHACK_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps resolve nethack --arch wasm32 2>/dev/null || true)"
        INSTALL_LOCAL_MIRROR=1
        ;;
    2)
        NETHACK_DIR="$1"
        OUTPUT_FILE="$2"
        ;;
    *)
        echo "usage: $0 [<dependency-dir> <output.zip>]" >&2
        exit 2
        ;;
esac

NETHACK_WASM=""
RUNTIME_ROOT=""
if [ -n "$NETHACK_DIR" ] && [ -f "$NETHACK_DIR/nethack.wasm" ] \
   && [ -d "$NETHACK_DIR/runtime/share/nethack" ]; then
    NETHACK_WASM="$NETHACK_DIR/nethack.wasm"
    RUNTIME_ROOT="$NETHACK_DIR/runtime/share/nethack"
elif [ -f "$REPO_ROOT/packages/registry/nethack/bin/nethack.wasm" ] \
   && [ -d "$REPO_ROOT/packages/registry/nethack/runtime/share/nethack" ]; then
    # Fallback: in-tree build artifacts.
    NETHACK_WASM="$REPO_ROOT/packages/registry/nethack/bin/nethack.wasm"
    RUNTIME_ROOT="$REPO_ROOT/packages/registry/nethack/runtime/share/nethack"
else
    echo "nethack package not found." >&2
    echo "  cache lookup: ${NETHACK_DIR:-<resolve failed>}" >&2
    echo "  expected: nethack.wasm + runtime/share/nethack/ in cache canonical dir" >&2
    echo "  or build locally: bash packages/registry/nethack/build-nethack.sh" >&2
    exit 1
fi

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/nethack-zip.XXXXXX")"
else
    STAGING="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging nethack.zip..."
echo "    binary:  $NETHACK_WASM"
echo "    runtime: $RUNTIME_ROOT"

# Binary — stored at bin/nethack (no .wasm extension, matching the VFS layout)
mkdir -p "$STAGING/bin"
cp "$NETHACK_WASM" "$STAGING/bin/nethack"
chmod 755 "$STAGING/bin/nethack"

# Runtime files — staged under share/nethack/
mkdir -p "$STAGING/share/nethack"
cp -R "$RUNTIME_ROOT/." "$STAGING/share/nethack/"
chmod -R a+rX "$STAGING/share/nethack"

bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"

# Install into local-binaries/ so the resolver picks the locally-built
# nethack.zip over a fetched release. This ZIP is the declared output of
# nethack-browser-bundle, not nethack: nethack owns nethack.wasm and its
# runtime tree. Keeping that ownership exact lets the resolver validate the
# output against the same package manifest that archive-stage is building.
if [ "$INSTALL_LOCAL_MIRROR" -eq 1 ]; then
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary nethack-browser-bundle "$OUTPUT_FILE" nethack.zip
fi
