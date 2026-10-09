#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
go_root="$(cd "$repo_root/../go-kandelo" && pwd)"
go_bin="${GO_KANDELO_BIN:-$go_root/bin/go}"
source_repo="$repo_root/.context/roadrunner"
output_dir="$repo_root/.context"
source_commit="207b2b4ba75f2529ecccf801b3d8dd7038f22732"

if [[ ! -x "$go_bin" ]]; then
  echo "Go fork binary not found: $go_bin" >&2
  exit 1
fi
if [[ ! -d "$source_repo/.git" ]]; then
  git clone --depth 1 --branch v2025.1.6 \
    https://github.com/roadrunner-server/roadrunner.git "$source_repo"
fi
if ! git -C "$source_repo" cat-file -e "$source_commit^{commit}"; then
  echo "RoadRunner source commit not found: $source_commit" >&2
  exit 1
fi

work_dir="$(mktemp -d "$output_dir/roadrunner-build.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
git -C "$source_repo" archive "$source_commit" | tar -x -C "$work_dir"

(
  cd "$work_dir"
  GOROOT="$go_root" "$go_bin" mod edit \
    "-replace=github.com/roadrunner-server/tcplisten=$repo_root/tests/go/roadrunner/tcplisten"
  GOROOT="$go_root" \
    GOMODCACHE="$output_dir/go-roadrunner-modcache" \
    GOCACHE="$output_dir/go-roadrunner-cache" \
    GOOS=kandelo GOARCH=wasm CGO_ENABLED=0 GOTOOLCHAIN=local \
    "$go_bin" build -mod=mod -o "$output_dir/roadrunner-minimal.wasm" \
    "$repo_root/tests/go/roadrunner/main.go"
)

source "$repo_root/sdk/activate.sh"
wasm32posix-cc -O2 "$repo_root/tests/go/roadrunner/supervisor.c" \
  -o "$output_dir/roadrunner-supervisor.wasm"

host_target="$(rustc -vV | sed -n 's/^host: //p')"
(cd "$repo_root" && cargo run -p xtask --target "$host_target" --quiet -- \
  stamp-abi-contract "$output_dir/roadrunner-minimal.wasm" \
  "$output_dir/roadrunner-supervisor.wasm")

printf 'RoadRunner fixtures built in %s\n' "$output_dir"
