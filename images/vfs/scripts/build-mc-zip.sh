#!/usr/bin/env bash
#
# Build mc.zip for the browser shell demo.
#
# Packages mc.wasm plus the data tree mc loads at startup (share/mc skins,
# syntax and help; etc/mc config; libexec/mc helper scripts) into a single
# archive. The demo registers this as a lazy archive with mount prefix
# /usr/, so entries become /usr/bin/mc, /usr/share/mc/... and
# /usr/etc/mc/... — the paths mc was configured with. On first exec of mc
# the whole archive is fetched and unpacked in one go.
#
# With `<dependency-dir> <output.zip>`, consumes only that exact declared
# dependency and writes only the selected output. With no arguments, retains
# the standalone developer mode: resolve mc, write the browser public asset,
# and install the result into the ordinary local mirror.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

INSTALL_LOCAL_MIRROR=0
case "$#" in
    0)
        OUTPUT_FILE="$REPO_ROOT/apps/browser-demos/public/mc.zip"
        # Standalone developer mode resolves the package on demand. Canonical
        # package builds pass their direct dependency explicitly instead.
        HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
        MC_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
            build-deps resolve mc --arch wasm32 2>/dev/null || true)"
        INSTALL_LOCAL_MIRROR=1
        ;;
    2)
        MC_DIR="$1"
        OUTPUT_FILE="$2"
        ;;
    *)
        echo "usage: $0 [<dependency-dir> <output.zip>]" >&2
        exit 2
        ;;
esac

if [ -z "${MC_DIR:-}" ] || [ ! -f "$MC_DIR/mc.wasm" ] || [ ! -f "$MC_DIR/mc-runtime.zip" ]; then
    echo "mc package not found." >&2
    echo "  cache lookup: ${MC_DIR:-<resolve failed>}" >&2
    echo "  expected: mc.wasm + mc-runtime.zip in the cache canonical dir" >&2
    echo "  or build locally: bash packages/registry/mc/build-mc.sh" >&2
    exit 1
fi

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/mc-zip.XXXXXX")"
else
    STAGING="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging mc.zip..."
echo "    binary:  $MC_DIR/mc.wasm"
echo "    runtime: $MC_DIR/mc-runtime.zip"

# Binary — stored at bin/mc (no .wasm extension, matching the VFS layout)
mkdir -p "$STAGING/bin"
cp "$MC_DIR/mc.wasm" "$STAGING/bin/mc"
chmod 755 "$STAGING/bin/mc"

# mc is one binary that selects its personality from argv[0]; upstream's
# `make install` publishes the other three names as symlinks to it (see
# src/Makefile.am install_mcview/install_mcedit/install_mcdiff). Reproduce
# them here rather than copying the 4 MB binary four times.
# create-deterministic-zip.sh stores symlinks as symlinks (zip -y).
for personality in mcedit mcview mcdiff; do
    ln -s mc "$STAGING/bin/$personality"
done

# Data tree — mc-runtime.zip is already rooted for /usr (share/, etc/,
# libexec/), so unpack it straight into the staging root.
unzip -q "$MC_DIR/mc-runtime.zip" -d "$STAGING"

[ -f "$STAGING/share/mc/skins/default.ini" ] || {
    echo "ERROR: staged mc.zip is missing share/mc/skins/default.ini" >&2
    exit 1
}
[ -f "$STAGING/etc/mc/mc.ext.ini" ] || {
    echo "ERROR: staged mc.zip is missing etc/mc/mc.ext.ini" >&2
    exit 1
}

bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"

echo "    $(find "$STAGING" \( -type f -o -type l \) | wc -l | tr -d ' ') entries"
ls -lh "$OUTPUT_FILE"

# Install into local-binaries/ so the resolver picks the locally-built mc.zip
# over the fetched release. This ZIP is the declared output of
# mc-browser-bundle, not mc: mc owns mc.wasm and mc-runtime.zip.
if [ "$INSTALL_LOCAL_MIRROR" -eq 1 ]; then
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary mc-browser-bundle "$OUTPUT_FILE" mc.zip
fi
