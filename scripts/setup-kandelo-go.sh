#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "$1" ]]; then
    echo "usage: scripts/dev-shell.sh scripts/setup-kandelo-go.sh <new-directory>" >&2
    exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$repo_root/scripts/kandelo-go-bootstrap.sh"

# Share the resolver's upstream pin with the standalone SDK installer.
metadata="$(python3 - "$repo_root/packages/registry/go-toolchain/build.toml" <<'PY'
from pathlib import Path
import sys
import tomllib

with Path(sys.argv[1]).open("rb") as recipe:
    upstream = next(entry for entry in tomllib.load(recipe)["git_inputs"]
                    if entry["name"] == "upstream_go")
print(upstream["repository"], upstream["commit"], sep="\t")
PY
)"
IFS=$'\t' read -r upstream_url upstream_commit <<< "$metadata"

mkdir -p -- "$(dirname -- "$1")"
mkdir -- "$1"
install_root="$(cd -- "$1" && pwd -P)"
toolchain_root="$install_root/go"

git init -q "$toolchain_root"
git -C "$toolchain_root" fetch --depth=1 "$upstream_url" "$upstream_commit"
git -C "$toolchain_root" checkout --detach "$upstream_commit"
kandelo_go_patch_sources "$toolchain_root" "$repo_root/sdk/go/patches"
kandelo_go_build_host_tools "$toolchain_root" "$install_root" "$upstream_commit"
printf 'KANDELO_GO_ROOT=%q\n' "$toolchain_root"
