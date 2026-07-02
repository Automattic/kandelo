#!/usr/bin/env bash
set -euo pipefail

# Build Kandelo's compact POSIX utility set for wasm32-posix-kernel.
# Output: packages/registry/posix-utils-lite/bin/<utility>.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC="$SCRIPT_DIR/src/posix-utils-lite.c"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

UTILITIES=(
  ar asa cal cflow compress ctags cxref ed ex fuser gencat getconf gettext
  iconv ipcrm ipcs lex locale logger man more msgfmt ngettext nm patch pax
  ps renice strings strip uncompress uudecode uuencode what xgettext
  yacc
)

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

mkdir -p "$BIN_DIR"

echo "==> Building posix-utils-lite multicall binary..."
wasm32posix-cc \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -O2 \
    -Wall \
    -Wextra \
    -Wno-unused-parameter \
    "$SRC" \
    -o "$BIN_DIR/posix-utils-lite.wasm"

for utility in "${UTILITIES[@]}"; do
    cp "$BIN_DIR/posix-utils-lite.wasm" "$BIN_DIR/$utility.wasm"
done

echo "==> posix-utils-lite built successfully."

source "$REPO_ROOT/scripts/install-local-binary.sh"
for utility in "${UTILITIES[@]}"; do
    install_local_binary posix-utils-lite "$BIN_DIR/$utility.wasm"
done
