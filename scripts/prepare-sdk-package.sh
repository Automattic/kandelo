#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_DIR="$REPO_ROOT/sdk"

if [ ! -f "$REPO_ROOT/sysroot/lib/libc.a" ]; then
    echo "prepare-sdk-package: missing sysroot/lib/libc.a" >&2
    echo "  run: bash scripts/build-musl.sh" >&2
    exit 1
fi

rm -rf "$SDK_DIR/glue" "$SDK_DIR/sysroot" "$SDK_DIR/sysroot64"
cp -R "$REPO_ROOT/glue" "$SDK_DIR/glue"
cp -R "$REPO_ROOT/sysroot" "$SDK_DIR/sysroot"
echo "prepare-sdk-package: copied glue/ and sysroot/"

if [ -f "$REPO_ROOT/sysroot64/lib/libc.a" ]; then
    cp -R "$REPO_ROOT/sysroot64" "$SDK_DIR/sysroot64"
    echo "prepare-sdk-package: copied sysroot64/"
else
    echo "prepare-sdk-package: sysroot64 not present; wasm64 tools will require WASM_POSIX_SYSROOT" >&2
fi
