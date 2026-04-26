#!/bin/bash
set -euo pipefail

echo "Building Rust Wasm kernel (wasm64)..."
cargo build --release -p wasm-posix-kernel \
  -Z build-std=core,alloc \
  -Z build-std-features=panic_immediate_abort

echo "Copying Wasm artifacts..."
mkdir -p host/wasm
cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm host/wasm/

echo "Building wasm-fork-instrument CLI (host tool)..."
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo build --release --target "$HOST_TRIPLE" -p fork-instrument --bin wasm-fork-instrument
mkdir -p tools/bin
cp "target/$HOST_TRIPLE/release/wasm-fork-instrument" tools/bin/wasm-fork-instrument

if [ -d programs ] && ls programs/*.c >/dev/null 2>&1; then
    echo "Building user programs..."
    bash scripts/build-programs.sh
fi

echo "Building TypeScript host..."
cd host
npm install --prefer-offline
npm run build
cd ..

echo "Build complete."
