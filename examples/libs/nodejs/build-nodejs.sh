#!/usr/bin/env bash
# Build Node.js for wasm32-posix.
#
# Phase 0: clones Node.js v24.x and builds the host-side torque binary only.
# Later phases add patches, configure, make, and wasm cross-compile.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${HERE}/build"
NODE_SRC="${BUILD_DIR}/node"
NODE_BRANCH="v24.x"
NODE_REPO="https://github.com/nodejs/node.git"

mkdir -p "${BUILD_DIR}"

if [ ! -d "${NODE_SRC}/.git" ]; then
  echo ">>> Cloning Node.js ${NODE_BRANCH} (shallow)..."
  git clone --depth 1 --branch "${NODE_BRANCH}" "${NODE_REPO}" "${NODE_SRC}"
else
  echo ">>> Node.js source already present at ${NODE_SRC}; skipping clone."
fi

echo ">>> Node.js HEAD: $(cd "${NODE_SRC}" && git rev-parse --short HEAD) on ${NODE_BRANCH}"
echo ">>> V8 version: $(grep -E 'V8_(MAJOR|MINOR|BUILD|PATCH)' "${NODE_SRC}/deps/v8/include/v8-version.h" | awk '{print $3}' | paste -sd. -)"

PATCH_DIR="${HERE}/patches"
PATCH_MARKER_DIR="${NODE_SRC}/.wasm-posix-kernel-patches"
mkdir -p "${PATCH_MARKER_DIR}"

for patch in "${PATCH_DIR}"/*.patch; do
  [ -f "${patch}" ] || continue
  marker="${PATCH_MARKER_DIR}/$(basename "${patch}").applied"
  if [ -f "${marker}" ]; then
    echo ">>> Already applied: $(basename "${patch}")"
    continue
  fi
  echo ">>> Applying patch: $(basename "${patch}")"
  (cd "${NODE_SRC}" && git apply --3way "${patch}")
  touch "${marker}"
done

echo ">>> Phase 0: torque host build only."
cd "${NODE_SRC}"

# Node.js's configure pulls in Python + GN deps. For Phase 0 we only need
# the torque binary. ./configure --help lists --without-* flags we'll use.
# Host-only build does not need cross-compilation plumbing.
if [ ! -f "out/Release/torque" ]; then
  ./configure --ninja
  # Node.js uses gyp+ninja. Build the `torque` executable target directly.
  ninja -C out/Release torque
else
  echo ">>> torque binary already built at out/Release/torque."
fi

test -x "${NODE_SRC}/out/Release/torque"
echo ">>> Phase 0 OK: torque binary at ${NODE_SRC}/out/Release/torque"
echo ">>> ($(file "${NODE_SRC}/out/Release/torque" | cut -d: -f2-))"
