#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "$1" ]]; then
    echo "usage: scripts/dev-shell.sh scripts/setup-kandelo-go.sh <new-directory>" >&2
    exit 2
fi

readonly bootstrap_url=https://go.dev/dl/go1.26.10.src.tar.gz
readonly bootstrap_sha=fd63e883ba2f2bfca93c1646b31ebef63e2b1e4d2b317c9789d976a68d81f36f
readonly upstream_url=https://github.com/golang/go.git
readonly upstream_commit=6c49ac311e5642fa5399b46c736295a9dc4eeec9
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

mkdir -p -- "$(dirname -- "$1")"
mkdir -- "$1"
install_root="$(cd -- "$1" && pwd -P)"
bootstrap_root="$install_root/go-bootstrap"
toolchain_root="$install_root/go"
download_dir="$(mktemp -d "$install_root/.download.XXXXXX")"
trap 'rm -rf -- "$download_dir"' EXIT

curl --proto '=https' --fail --silent --show-error --location \
    "$bootstrap_url" -o "$download_dir/bootstrap.tar.gz"
printf '%s  %s\n' "$bootstrap_sha" "$download_dir/bootstrap.tar.gz" | sha256sum --check --status
mkdir "$bootstrap_root"
tar -xf "$download_dir/bootstrap.tar.gz" --strip-components=1 -C "$bootstrap_root"

git init -q "$toolchain_root"
git -C "$toolchain_root" fetch --depth=1 "$upstream_url" "$upstream_commit"
git -C "$toolchain_root" checkout --detach "$upstream_commit"
for patch in "$repo_root"/sdk/go/patches/*.patch; do
    git -C "$toolchain_root" apply --index --whitespace=nowarn -- "$patch"
done

# Go's default development version identifies HEAD. Use the patched tree ID
# so the compiler reports a version that identifies the sources it builds.
toolchain_tree="$(git -C "$toolchain_root" write-tree)"
go_minor="$(sed -n 's/^const Version = \([0-9][0-9]*\)$/\1/p' \
    "$toolchain_root/src/internal/goversion/goversion.go")"
: "${go_minor:?could not determine the Go development version}"
toolchain_version="go1.${go_minor}-devel_kandelo-${toolchain_tree}"
printf '%s\n' "$toolchain_version" > "$toolchain_root/VERSION"

mkdir "$install_root/gocache" "$install_root/tmp"
(
    # The two compilers run on the build host, outside the SDK cross settings.
    unset GOOS GOARCH GOROOT CC CXX AR RANLIB
    export GOENV=off GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0
    # Go's builder mode trims the bootstrap's source and work paths.
    export GO_BUILDER_NAME=kandelo-sdk
    export GOCACHE="$install_root/gocache" GOTMPDIR="$install_root/tmp"
    export GOMAXPROCS="${GOMAXPROCS:-4}" GOFLAGS="-trimpath -p=${GOMAXPROCS:-4}"
    export GOROOT_BOOTSTRAP="$(go env GOROOT)"
    echo "Building Go bootstrap compiler"
    (cd "$bootstrap_root/src" && ./make.bash)
    export GOROOT_BOOTSTRAP="$bootstrap_root"
    echo "Building Kandelo Go $toolchain_version from upstream $upstream_commit"
    (cd "$toolchain_root/src" && ./make.bash)
    "$toolchain_root/bin/go" version
)
printf 'KANDELO_GO_ROOT=%q\n' "$toolchain_root"
