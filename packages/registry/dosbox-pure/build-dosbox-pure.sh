#!/usr/bin/env bash
# Build the interpreter core and a POSIX/device libretro frontend. All writes
# belong to this resolve; the base sysroot and reviewed recipe stay read-only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/source"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?resolver must supply the libcxx dependency}"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot dosbox-pure "$REPO_ROOT/sysroot" libcxx)"
kandelo_package_stage_primary_source dosbox-pure "$SRC" "$WORK_DIR"
for patch_file in "$HERE"/patches/*.patch; do
    patch -d "$SRC" -p1 < "$patch_file"
done

# Upstream's makefile handles compilation and the static archive. The added
# target explicitly disables native code generation; no target CPU is faked.
make -C "$SRC" -j"${KANDELO_BUILD_JOBS:-4}" platform=kandelo
wasm32posix-c++ -std=gnu++17 -O2 -Wall -Wextra -Wno-unused-parameter \
    -D_DEFAULT_SOURCE -I"$SRC" \
    "$HERE/kandelo-libretro.cpp" "$SRC/libdosbox_pure.a" \
    -lc++ -lc++abi -lm -o "$WORK_DIR/dosbox-pure.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary dosbox-pure "$WORK_DIR/dosbox-pure.wasm" dosbox-pure.wasm
install_local_runtime_file dosbox-pure "$HERE/dos-play" bin/dos-play
install_local_runtime_file dosbox-pure "$HERE/games.tsv" share/dos-play/games.tsv
install_local_runtime_file dosbox-pure "$HERE/DOSDEF-UNLICENSE.txt" share/dos-play/DOSDEF-UNLICENSE.txt
