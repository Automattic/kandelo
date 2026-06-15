#!/usr/bin/env bash
#
# Build two variants of chain.wasm:
#   chain.baseline.wasm    — uninstrumented control
#   chain.forkinstr.wasm   — via tools/bin/wasm-fork-instrument
#
# Run inside the kandelo dev shell so wasm-ld is the flake-pinned
# LLVM 21 — Homebrew's LLVM 22 wasm-ld rejects the SDK's
# `--global-base` + `-z stack-size` combination.
#
#   bash scripts/dev-shell.sh bash benchmarks/fork/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
mkdir -p "$OUT_DIR"

if [ ! -f "$REPO_ROOT/sysroot/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $REPO_ROOT/sysroot." >&2
    echo "       Run: bash $REPO_ROOT/scripts/build-musl.sh (inside dev-shell)" >&2
    exit 1
fi
if [ ! -x "$REPO_ROOT/tools/bin/wasm-fork-instrument" ]; then
    echo "==> Building wasm-fork-instrument tool..."
    bash "$REPO_ROOT/scripts/build-fork-instrument-tool.sh"
fi
if ! command -v wasm-opt >/dev/null 2>&1; then
    echo "ERROR: wasm-opt not found. Open a dev shell via scripts/dev-shell.sh." >&2
    exit 1
fi
if ! command -v wasm32posix-cc >/dev/null 2>&1; then
    echo "ERROR: wasm32posix-cc not on PATH. Open dev-shell first." >&2
    exit 1
fi

echo "==> Compiling chain.c..."
# 64 MB shadow stack survives ~800k recursive frames so V8's C-stack
# overflow (the thing we measure) lands first, not wasm-side OOB.
wasm32posix-cc \
    -O2 \
    -Wl,-z,stack-size=67108864 \
    -Wl,--export=benchmark_walk \
    "$SCRIPT_DIR/chain.c" \
    -o "$OUT_DIR/chain.baseline.wasm"

echo "==> Running wasm-fork-instrument..."
"$REPO_ROOT/tools/bin/wasm-fork-instrument" \
    "$OUT_DIR/chain.baseline.wasm" \
    -o "$OUT_DIR/chain.forkinstr.wasm"

echo
echo "==> Build complete. Sizes:"
ls -la "$OUT_DIR"/chain.*.wasm | awk '{printf "    %-30s  %10d bytes\n", $9, $5}'

echo
echo "==> walk() declared local count (proxy for V8 per-frame cost):"
for variant in baseline forkinstr; do
    f="$OUT_DIR/chain.$variant.wasm"
    wat_file="$OUT_DIR/chain.$variant.wat"
    wasm-opt --print "$f" >"$wat_file" 2>/dev/null
    idx=$(awk '/\(export "benchmark_walk" \(func \$/ {
        match($0, /\$[0-9]+/); print substr($0, RSTART+1, RLENGTH-1); exit
    }' "$wat_file")
    locals=$(awk -v idx="$idx" '
        $0 ~ "\\(func \\$" idx " " { in_walk=1; next }
        in_walk && /\(local / { count++ }
        in_walk && /^ \)/ { print count+0; exit }
    ' "$wat_file")
    printf "    chain.%-9s walk locals: %s\n" "$variant" "${locals:-?}"
done
