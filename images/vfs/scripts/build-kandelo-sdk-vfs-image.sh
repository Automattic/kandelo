#!/usr/bin/env bash
#
# Build kandelo-sdk.vfs.zst. packages/registry/kandelo-sdk/build-kandelo-sdk.sh
# is the supported caller; it sets every input this builder requires:
#   WASM_POSIX_SYSROOT      a sysroot staged by stage-sdk-sysroot.sh (the
#                           checkout's shared sysroot/ is refused)
#   KANDELO_SDK_LIBCXX_DIR  the libcxx package output
#   KANDELO_SDK_DRIVER      kandelo-cc.wasm
#   KANDELO_SDK_WASM_OPT    wasm-opt.wasm
# and KANDELO_SDK_VFS_OUT, the output path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

KANDELO_SDK_TSX_TMP="$(mktemp -d /tmp/kandelo-sdk-vfs.XXXXXX)"
trap 'rm -rf -- "$KANDELO_SDK_TSX_TMP"' EXIT
TMPDIR="$KANDELO_SDK_TSX_TMP" \
  npx tsx images/vfs/scripts/build-kandelo-sdk-vfs-image.ts "$@"
