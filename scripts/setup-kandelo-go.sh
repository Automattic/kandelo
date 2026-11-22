#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "$1" ]]; then
    echo "usage: scripts/dev-shell.sh scripts/setup-kandelo-go.sh <new-directory>" >&2
    exit 2
fi

readonly bootstrap_url=https://go.dev/dl/go1.26.10.src.tar.gz
readonly bootstrap_sha=fd63e883ba2f2bfca93c1646b31ebef63e2b1e4d2b317c9789d976a68d81f36f
readonly toolchain_url=https://github.com/kandelo-dev/go.git
readonly toolchain_commit=faacee3a3e979eae90c209d9aff212185207a0b4

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
git -C "$toolchain_root" fetch --depth=1 "$toolchain_url" "$toolchain_commit"
git -C "$toolchain_root" checkout --detach "$toolchain_commit"

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
    echo "Building Kandelo Go $toolchain_commit"
    (cd "$toolchain_root/src" && ./make.bash)
    "$toolchain_root/bin/go" version
)
printf 'KANDELO_GO_ROOT=%q\n' "$toolchain_root"
