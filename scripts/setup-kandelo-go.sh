#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# != 1 || -z "$1" ]]; then
    echo "usage: scripts/dev-shell.sh scripts/setup-kandelo-go.sh <new-directory>" >&2
    exit 2
fi

# Read the same pins that the package resolver uses for go-hello.
pins="$(python3 - "$repo_root" <<'PY'
import pathlib
import sys
import tomllib

registry = pathlib.Path(sys.argv[1]) / "packages/registry"
with (registry / "go-bootstrap-source/package.toml").open("rb") as f:
    archive = tomllib.load(f)["source"]
with (registry / "go-hello/build.toml").open("rb") as f:
    selected = next(x for x in tomllib.load(f)["git_inputs"] if x["name"] == "go_toolchain")
print(archive["url"], archive["sha256"], selected["repository"], selected["commit"], sep="\n")
PY
)"
{
    read -r bootstrap_url
    read -r bootstrap_sha
    read -r toolchain_url
    read -r toolchain_commit
} <<< "$pins"

mkdir -p -- "$(dirname -- "$1")"
mkdir -- "$1"
install_root="$(cd -- "$1" && pwd -P)"
sources="$(mktemp -d "$install_root/.sources.XXXXXX")"
trap 'rm -rf -- "$sources"' EXIT

curl --proto '=https' --fail --silent --show-error --location \
    "$bootstrap_url" -o "$sources/bootstrap.tar.gz"
printf '%s  %s\n' "$bootstrap_sha" "$sources/bootstrap.tar.gz" | sha256sum --check --status
mkdir "$sources/bootstrap"
tar -xf "$sources/bootstrap.tar.gz" --strip-components=1 -C "$sources/bootstrap"

git init -q "$sources/toolchain"
git -C "$sources/toolchain" fetch --depth=1 "$toolchain_url" "$toolchain_commit"
git -C "$sources/toolchain" checkout --detach FETCH_HEAD

source "$repo_root/scripts/build-kandelo-go-toolchain.sh"
kandelo_build_go_toolchain "$install_root" "$sources/bootstrap" "$sources/toolchain" "$toolchain_commit"
printf 'KANDELO_GO_ROOT=%q\n' "$KANDELO_BUILT_GO_ROOT"
