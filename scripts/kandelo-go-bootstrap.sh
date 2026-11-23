#!/usr/bin/env bash
# Shared by the SDK installer and the guest toolchain recipe.

kandelo_go_patch_sources() {
    local root="$1" patch_dir="$2" patch tree minor
    for patch in "$patch_dir"/*.patch; do
        git -C "$root" apply --index --whitespace=nowarn -- "$patch" || return
    done

    # Identify the patched source tree in the compiler's version.
    tree="$(git -C "$root" write-tree)" || return
    minor="$(sed -n 's/^const Version = \([0-9][0-9]*\)$/\1/p' \
        "$root/src/internal/goversion/goversion.go")" || return
    : "${minor:?could not determine the Go development version}"
    printf 'go1.%s-devel_kandelo-%s\n' "$minor" "$tree" > "$root/VERSION"
}

kandelo_go_build_host_tools() (
    set -e
    local toolchain_root="$1" work="$2" upstream_commit="$3"
    mkdir -p "$work/gocache" "$work/tmp"
    # Use the Go compiler provided by the pinned Kandelo dev shell.
    unset GOOS GOARCH GOROOT CC CXX AR RANLIB
    export GOENV=off GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0
    export GO_BUILDER_NAME=kandelo-sdk
    export GOCACHE="$work/gocache" GOTMPDIR="$work/tmp"
    export GOMAXPROCS="${GOMAXPROCS:-4}" GOFLAGS="-trimpath -p=${GOMAXPROCS:-4}"
    export GOROOT_BOOTSTRAP
    GOROOT_BOOTSTRAP="$(go env GOROOT)"
    echo "Building Kandelo Go $(cat "$toolchain_root/VERSION") from upstream $upstream_commit"
    (cd "$toolchain_root/src" && ./make.bash)
    "$toolchain_root/bin/go" version
)
