#!/usr/bin/env bash
# Source this helper from the Go SDK installer or a Go package recipe.
# Native compilers are build tools, never guest package outputs.
kandelo_build_go_toolchain() {
    local work_dir="$1" bootstrap_source="$2" toolchain_source="$3" toolchain_commit="$4"
    local bootstrap_root="$work_dir/go-bootstrap"
    local target_root="$work_dir/go"
    mkdir -p "$bootstrap_root" "$target_root" "$work_dir/gocache" "$work_dir/tmp"
    tar -cf - -C "$bootstrap_source" . |
        tar -xf - -C "$bootstrap_root"
    # Preserve the sealed input's Git metadata in the private copy: Go's own
    # version generator then identifies the exact fork commit reproducibly.
    tar -cf - -C "$toolchain_source" . |
        tar -xf - -C "$target_root"
    chmod -R u+w "$bootstrap_root" "$target_root"
    if [[ "$(git -C "$target_root" rev-parse HEAD)" != "$toolchain_commit" ]]; then
        echo "Kandelo Go source copy differs from the declared commit" >&2
        return 2
    fi
    (
        # SDK cross-compiler settings must not enter the native bootstrap.
        unset GOOS GOARCH GOROOT CC CXX AR RANLIB
        export GOENV=off GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0
        # Development Go otherwise keeps scratch-root paths in its own tools.
        # Upstream's builder mode trims those paths, making their content IDs
        # (and the target build IDs derived from them) reproducible too.
        export GO_BUILDER_NAME=kandelo-package
        export GOCACHE="$work_dir/gocache" GOTMPDIR="$work_dir/tmp"
        export GOMAXPROCS="${GOMAXPROCS:-4}" GOFLAGS="-trimpath -p=${GOMAXPROCS:-4}"
        export GOROOT_BOOTSTRAP="$(go env GOROOT)"
        echo "Building declared Go bootstrap source"
        (cd "$bootstrap_root/src" && ./make.bash)
        export GOROOT_BOOTSTRAP="$bootstrap_root"
        echo "Building Kandelo Go $toolchain_commit"
        (cd "$target_root/src" && ./make.bash)
        "$target_root/bin/go" version
    ) || return
    export KANDELO_BUILT_GO_ROOT="$target_root"
}
