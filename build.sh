#!/bin/bash
set -euo pipefail

echo "Building Rust Wasm kernel (wasm64)..."
cargo build --release -p wasm-posix-kernel \
  -Z build-std=core,alloc

echo "Copying Wasm artifacts into local-binaries/..."
# local-binaries/ is the per-checkout override tree. The resolver
# (host/src/binary-resolver.ts) prefers it over binaries/ so locally
# rebuilt artifacts shadow whatever scripts/fetch-binaries.sh
# downloaded. See docs/binary-releases.md.
mkdir -p local-binaries
cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm \
   local-binaries/kernel.wasm
if [ -f target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm ]; then
    cp target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm \
       local-binaries/userspace.wasm
fi

if [ -d programs ] && ls programs/*.c >/dev/null 2>&1; then
    echo "Building user programs..."
    bash scripts/build-programs.sh
fi

echo "Building TypeScript host..."
cd host
npm install --prefer-offline
npm run build
cd ..

echo "Building rootfs.vfs..."
bash scripts/build-rootfs.sh

echo "Build complete."
