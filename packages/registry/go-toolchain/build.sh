#!/usr/bin/env bash
set -euo pipefail

recipe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$recipe_dir/../../.." && pwd -P)"
source "$repo/scripts/package-build-roots.sh"
source "$repo/scripts/kandelo-go-bootstrap.sh"

: "${WASM_POSIX_DEP_WORK_DIR:?build go-toolchain through the package resolver}"
: "${WASM_POSIX_DEP_OUT_DIR:?build go-toolchain through the package resolver}"
: "${WASM_POSIX_BUILD_GIT_UPSTREAM_GO_DIR:?missing resolved upstream Go source}"
: "${WASM_POSIX_BUILD_GIT_UPSTREAM_GO_COMMIT:?missing resolved upstream Go revision}"
kandelo_package_prepare_build_roots "$WASM_POSIX_DEP_WORK_DIR" wasm32

work="$KANDELO_PACKAGE_WORK_DIR"
toolchain="$work/go"
stage="$work/stage"
goroot="$stage/lib/go"
tool_dir="$goroot/pkg/tool/kandelo_wasm32"
upstream="$WASM_POSIX_BUILD_GIT_UPSTREAM_GO_COMMIT"

# The resolver owns the immutable source checkout. Patches and bootstrap
# outputs both need a writable checkout below this build's work root.
git clone --quiet --shared --no-checkout "$WASM_POSIX_BUILD_GIT_UPSTREAM_GO_DIR" "$toolchain"
git -C "$toolchain" checkout --quiet --detach "$upstream"
kandelo_go_patch_sources "$toolchain" "$repo/sdk/go/patches"
kandelo_go_build_host_tools "$toolchain" "$work" "$upstream"

mkdir -p "$stage/bin" "$goroot/bin" "$tool_dir"
export KANDELO_GO_ROOT="$toolchain" GOCACHE="$work/gocache" GOTMPDIR="$work/tmp"
export GOPROXY=off GOSUMDB=off GOWORK=off
"$repo/sdk/bin/wasm32posix-go" build -p 4 -trimpath -ldflags="-s -w" -o "$tool_dir/" \
    cmd/go cmd/compile cmd/asm cmd/link
mv "$tool_dir/go" "$goroot/bin/go"
ln -s ../lib/go/bin/go "$stage/bin/go"
# Ship the files that can build the standard library for this target.
# The image has to index every lazy path, even before fetching the archive.
mv "$toolchain/src/cmd" "$work/go-command-source"
find "$toolchain/src" -type d -name testdata -prune -exec rm -r -- {} +
find "$toolchain/src" -type f -name '*_test.go' -delete
"$toolchain/bin/go" run "$recipe_dir/prune-stdlib.go" "$toolchain/src"
mv "$toolchain/src" "$toolchain/lib" "$goroot/"
mv "$toolchain/pkg/include" "$goroot/pkg/"
mv "$toolchain/LICENSE" "$toolchain/PATENTS" "$toolchain/VERSION" "$toolchain/go.env" "$goroot/"

source "$repo/scripts/wasm-artifact-guards.sh"
for tool in "$goroot/bin/go" "$tool_dir/"*; do
    wasm_require_fork_instrumentation_if_needed "$tool"
done

bundle="$work/go.zip"
bash "$repo/images/vfs/scripts/create-deterministic-zip.sh" "$stage" "$bundle"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
source "$repo/scripts/install-local-binary.sh"
install_local_binary go-toolchain "$bundle" go.zip
