#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"

: "${WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR:?pinned Go source is required}"
: "${WASM_POSIX_BUILD_GIT_XSYS_DIR:?pinned x/sys source is required}"
: "${WASM_POSIX_BUILD_GIT_BBOLT_DIR:?pinned bbolt source is required}"
: "${WASM_POSIX_BUILD_GIT_READLINE_DIR:?pinned readline source is required}"
: "${WASM_POSIX_BUILD_GIT_LOGRUS_DIR:?pinned logrus source is required}"
: "${WASM_POSIX_BUILD_GIT_CERTIFICATE_TRANSPARENCY_DIR:?pinned certificate-transparency source is required}"

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
GO_ROOT="$WORK_DIR/go"
SOURCE_DIR="$WORK_DIR/caddy-src"
mkdir -p "$GO_ROOT" "$WORK_DIR/tmp" "$WORK_DIR/gocache" "$WORK_DIR/gopath" "$WORK_DIR/gomodcache"

tar --exclude=.git -cf - -C "$WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR" . |
    tar -xf - -C "$GO_ROOT"
chmod -R u+w "$GO_ROOT"
export GOROOT_BOOTSTRAP="$(go env GOROOT)"
(cd "$GO_ROOT/src" && ./make.bash)

kandelo_package_stage_verified_source caddy "$SOURCE_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"

stage_go_module() {
    local name="$1" source="$2" module="$3"
    local destination="$WORK_DIR/$name"
    mkdir -p "$destination"
    tar --exclude=.git -cf - -C "$source" . |
        tar -xf - -C "$destination"
    chmod -R u+w "$destination"
    (cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" mod edit -replace="$module=../$name")
}

export GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=
export GOCACHE="$WORK_DIR/gocache" GOPATH="$WORK_DIR/gopath"
export GOMODCACHE="$WORK_DIR/gomodcache" GOTMPDIR="$WORK_DIR/tmp"
export GOROOT="$GO_ROOT" GOOS=kandelo GOARCH=wasm CGO_ENABLED=0

stage_go_module xsys "$WASM_POSIX_BUILD_GIT_XSYS_DIR" golang.org/x/sys
stage_go_module bbolt "$WASM_POSIX_BUILD_GIT_BBOLT_DIR" go.etcd.io/bbolt
stage_go_module readline "$WASM_POSIX_BUILD_GIT_READLINE_DIR" github.com/chzyer/readline
stage_go_module logrus "$WASM_POSIX_BUILD_GIT_LOGRUS_DIR" github.com/sirupsen/logrus
stage_go_module certificate-transparency "$WASM_POSIX_BUILD_GIT_CERTIFICATE_TRANSPARENCY_DIR" github.com/google/certificate-transparency-go

(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" mod tidy)
(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" build -o "$WORK_DIR/caddy.wasm" ./cmd/caddy)
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$WORK_DIR/caddy.wasm" \
    -o "$WORK_DIR/caddy-instrumented.wasm"
if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" != source-only-v1 ]; then
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$WORK_DIR/caddy-instrumented.wasm"
    stamp_built_program_outputs
fi

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary caddy "$WORK_DIR/caddy-instrumented.wasm" caddy.wasm
