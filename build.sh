#!/bin/bash
set -euo pipefail

echo "Building Rust Wasm kernel (wasm32)..."
cargo build --release -p kandelo \
  -Z build-std=core,alloc

echo "Installing Wasm artifacts into local-binaries/..."
# WHY: local-binaries/ is a package-owned resolver tier. Going through the
# generation installer preserves artifact identity and prevents a later
# dependency walk from silently replacing this checkout's exact build.
source scripts/install-local-binary.sh
install_local_binary kernel \
    target/wasm32-unknown-unknown/release/kandelo_kernel.wasm \
    kandelo-kernel.wasm

echo "Building wasm-fork-instrument CLI (host tool)..."
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo build --release --target "$HOST_TRIPLE" -p fork-instrument --bin wasm-fork-instrument
mkdir -p tools/bin
cp "target/$HOST_TRIPLE/release/wasm-fork-instrument" tools/bin/wasm-fork-instrument

echo "Generating program package index (derived, gitignored)..."
# The program index is a projection of packages/registry/*/package.toml. Its
# cache keys hash the build/toolchain trees, so it is generated (not committed);
# build-programs.sh, the TS resolver, and the npm host package consume it.
cargo run --release --target "$HOST_TRIPLE" -p xtask --quiet -- \
    build-deps program-index \
    --source-repo-root "$PWD" \
    packages/registry \
    packages/registry/program-packages.json

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
