#!/usr/bin/env bash
#
# Build the browser lazy-archive bundle for the Kandelo C/C++ toolchain.
#
# The package-system archive remains a .tar.zst, but its declared output is
# kandelo-sdk.zip. Resolver consumers see the bare zip at
# programs/wasm32/kandelo-sdk.zip. The zip bundles cc/c++ (clang + wasm-ld +
# llvm-ar/ranlib/nm), the Clang resource headers, and the SDK sysroot
# (musl libc + libc++), so a browser shell can compile and link C/C++
# programs after one lazy-archive fetch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
CLANG_DIR="${WASM_POSIX_DEP_CLANG_DIR:-}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"

fail() {
    echo "build-kandelo-sdk-browser-bundle: $*" >&2
    exit 2
}

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32

[ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" = wasm32 ] ||
    fail "only wasm32 supported (got ${WASM_POSIX_DEP_TARGET_ARCH:-})"
for variable in WASM_POSIX_DEP_OUT_DIR WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_CLANG_DIR WASM_POSIX_DEP_LIBCXX_DIR; do
    root="$(kandelo_package_require_existing_real_dir "$variable" "${!variable:-}")"
    [ "$root" = "${!variable}" ] || fail "$variable must use its canonical path"
done
for dependency_root in "$CLANG_DIR" "$LIBCXX_DIR"; do
    kandelo_package_require_regular_input_tree dependency "$dependency_root"
    kandelo_package_require_disjoint_paths dependency "$dependency_root" work "$WORK_DIR"
    kandelo_package_require_disjoint_paths dependency "$dependency_root" output "$OUT_DIR"
done
kandelo_package_require_disjoint_paths clang "$CLANG_DIR" libcxx "$LIBCXX_DIR"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

archive="$WORK_DIR/kandelo-sdk.zip"
bash "$REPO_ROOT/images/vfs/scripts/build-kandelo-sdk-zip.sh" \
    "$CLANG_DIR" "$LIBCXX_DIR" "$archive"

export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary kandelo-sdk-browser-bundle "$archive" kandelo-sdk.zip
