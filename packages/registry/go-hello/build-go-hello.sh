#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
source "$REPO_ROOT/sdk/activate.sh"

: "${WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR:?resolver-owned Go toolchain source is required}"
: "${WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_COMMIT:?pinned Go toolchain commit is required}"
if [ ! -f "$WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR/src/make.bash" ]; then
    echo "go-hello: pinned Go toolchain source is missing" >&2
    exit 2
fi

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
GO_ROOT="$WORK_DIR/go"
APP_DIR="$WORK_DIR/app"
mkdir -p "$GO_ROOT" "$APP_DIR" "$WORK_DIR/tmp" "$WORK_DIR/gocache" "$WORK_DIR/gopath"
tar --exclude=.git -cf - -C "$WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR" . |
    tar -xf - -C "$GO_ROOT"
chmod -R u+w "$GO_ROOT"
cp "$KANDELO_PACKAGE_SOURCE_ROOT/packages/registry/go-hello/main.go" "$APP_DIR/main.go"

export GOENV=off GOTOOLCHAIN=local GOWORK=off GOPROXY=off GOSUMDB=off GOFLAGS=
export GOCACHE="$WORK_DIR/gocache" GOPATH="$WORK_DIR/gopath" GOTMPDIR="$WORK_DIR/tmp"
export GOROOT_BOOTSTRAP="$(go env GOROOT)"
(cd "$GO_ROOT/src" && ./make.bash)

export KANDELO_GO_ROOT="$GO_ROOT"
wasm32posix-go build -o "$WORK_DIR/go-hello.wasm" "$APP_DIR/main.go"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary go-hello "$WORK_DIR/go-hello.wasm" go-hello.wasm
